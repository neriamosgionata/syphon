import fs from 'node:fs'
import type { BacktestSample } from '/home/amos-neri/Projects/syphon/backend/app/services/BacktestEngine.js'

// Minimal 1d kline fetch (standalone script — avoids the Adonis logger chain).
async function fetch1d(symbol: string, startTime: number, endTime: number): Promise<BacktestSample[]> {
  const pair = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`
  const out: BacktestSample[] = []
  let cursor = startTime
  const seen = new Set<number>()
  while (cursor < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&startTime=${cursor}&endTime=${endTime}&limit=1000`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`binance ${res.status} ${pair}`)
    const json = (await res.json()) as any[]
    if (!json.length) break
    for (const raw of json) {
      const t = Number(raw[0]); const close = Number(raw[4]); const high = Number(raw[2]); const low = Number(raw[3]); const vol = Number(raw[5])
      if (Number.isFinite(close) && close > 0 && !seen.has(t)) { seen.add(t); out.push({ t, p: close, h: high, l: low, v: vol }) }
    }
    const next = Number(json[json.length - 1][0])
    if (next <= cursor) break
    cursor = next + 86_400_000
    await new Promise((r) => setTimeout(r, 120))
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

const C = '/home/amos-neri/Projects/syphon/backend/backtests/cache'
const UNIVERSE = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK', 'LTC'] as const
const DAYS = 1500

function seriesMap(samples: BacktestSample[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of samples) m.set(new Date(s.t).toISOString().slice(0, 10), s.p)
  return m
}
function buildTimeline(all: Map<string, Map<string, number>>): Array<{ date: string; closes: Record<string, number> }> {
  const dates = new Set<string>()
  for (const m of all.values()) for (const d of m.keys()) dates.add(d)
  const rows: Array<{ date: string; closes: Record<string, number> }> = []
  const last = new Map<string, number>()
  for (const d of [...dates].sort()) {
    const closes: Record<string, number> = {}
    for (const sym of UNIVERSE) {
      const v = all.get(sym)!.get(d)
      if (v !== undefined) last.set(sym, v)
      if (last.has(sym)) closes[sym] = last.get(sym)!
    }
    rows.push({ date: d, closes })
  }
  return rows
}
function monthlyStarts(rows: Array<{ date: string }>): string[] {
  const out: string[] = []
  let lm = ''
  for (const r of rows) if (r.date.slice(0, 7) !== lm) { out.push(r.date); lm = r.date.slice(0, 7) }
  return out
}
function retN(rows: Array<{ date: string; closes: Record<string, number> }>, i: number, sym: string, n: number): number | null {
  const c = rows[i].closes[sym]
  const past = rows[Math.max(0, i - n)].closes[sym]
  if (c && past && past > 0) return c / past - 1
  return null
}

interface Out { label: string; full: number; monthly: number[]; yearly: Record<string, number>; bhBasket: number; bhBtc: number }

function run(rows: Array<{ date: string; closes: Record<string, number> }>, starts: string[], lookback: number, top: number, shortBottom: number, feePct: number): Out {
  const startSet = new Set(starts)
  const eqs: number[] = [1]
  const weights = new Map<string, number>()
  let prevW = new Map<string, number>()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (startSet.has(r.date)) {
      const rank = UNIVERSE
        .map((s) => [s, retN(rows, i, s, lookback)] as const)
        .filter(([, v]) => v !== null)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
      const next = new Map<string, number>()
      for (const [s] of rank.slice(0, top)) next.set(s, 1 / top)
      for (const [s] of rank.slice(rank.length - shortBottom)) next.set(s, -1 / shortBottom)
      // turnover fee: sum of absolute weight changes (per-side)
      let turnover = 0
      for (const s of UNIVERSE) {
        const a = weights.get(s) || 0
        const b = next.get(s) || 0
        if (a !== b) turnover += Math.abs(b - a)
      }
      for (const [s, w] of next) weights.set(s, w)
      for (const s of [...weights.keys()]) if (!next.has(s)) weights.delete(s)
      prevW = new Map(weights)
      if (turnover > 0) eqs[i] = eqs[i] * (1 - turnover * feePct)
    }
    let ret = 0
    for (const [sym, w] of weights) {
      const prevC = rows[Math.max(0, i - 1)].closes[sym]
      const c = r.closes[sym]
      if (prevC && prevC > 0 && w !== 0) { const dr = c / prevC - 1; if (!Number.isFinite(dr)) { console.log('BAD', i, sym, prevC, c); process.exit(1) } ret += w * dr }
    }
    const _e = eqs[i] * (1 + ret)
    if (!Number.isFinite(_e)) { console.log('EQNAN', i, eqs[i], ret); process.exit(1) }
    eqs.push(_e)
  }
  // Monthly returns from end-of-day equity (eqEnd[i] = end of row i).
  const eqEnd = eqs.slice(1)
  const lastEqByMonth = new Map<string, number>()
  for (let i = 0; i < rows.length; i++) {
    const mo = rows[i].date.slice(0, 7)
    const v = eqEnd[i]
    const prev = lastEqByMonth.get(mo)
    if (prev === undefined || (prev as unknown as number) < v) lastEqByMonth.set(mo, v)
  }
  const monthKeys = [...lastEqByMonth.keys()].sort()
  const monthly: number[] = []
  const yearly: Record<string, number> = {}
  let prevEq = 1
  for (const mo of monthKeys) {
    const e = lastEqByMonth.get(mo)!
    const mret = (e / prevEq - 1) * 100
    monthly.push(mret)
    yearly[mo.slice(0, 4)] = (yearly[mo.slice(0, 4)] || 0) + mret
    prevEq = e
  }
  const first = rows[0].closes
  const last = rows[rows.length - 1].closes
  let basket = 0
  for (const s of UNIVERSE) if (first[s] && last[s]) basket += last[s] / first[s] - 1
  basket = (basket / UNIVERSE.length) * 100
  const bhBtc = first.BTC ? (last.BTC / first.BTC - 1) * 100 : 0
  return { label: '', full: (eqs[eqs.length - 1] - 1) * 100, monthly, yearly, bhBasket: basket, bhBtc }
}

async function main() {
  const all = new Map<string, Map<string, number>>()
  for (const sym of UNIVERSE) {
    const cacheFile = `${C}/${sym}_1d_${DAYS}d.json`
    let samples: BacktestSample[]
    if (fs.existsSync(cacheFile)) samples = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    else {
      samples = await fetch1d(sym, Date.now() - DAYS * 86_400_000, Date.now())
      fs.writeFileSync(cacheFile, JSON.stringify(samples))
    }
    all.set(sym, seriesMap(samples))
  }
  const timeline = buildTimeline(all)
  const t0 = timeline.findIndex((r) => r.date >= '2023-09-01')
  const rows = timeline.slice(t0)
  const starts = monthlyStarts(rows)
  console.log(`universe ${UNIVERSE.length} assets, ${rows.length} daily rows (${rows[0].date} -> ${rows[rows.length - 1].date}), ${starts.length} rebalances`)

  const configs: Array<[string, number, number, number, number]> = [
    ['hold all (bh basket)', 90, 11, 0, 0],
    ['MOM top3 90d', 90, 3, 0, 0.001],
    ['MOM top5 90d', 90, 5, 0, 0.001],
    ['MOM top3 30d', 30, 3, 0, 0.001],
    ['MOM top3 180d', 180, 3, 0, 0.001],
    ['L/S top3-bot3 90d', 90, 3, 3, 0.001],
    ['L/S top3-bot3 30d', 30, 3, 3, 0.001],
  ]
  for (const [label, lookback, top, bottom, fee] of configs) {
    const r = run(rows, starts, lookback, top, bottom, fee)
    const up = r.monthly.filter((m) => m > 0).length
    const avg = r.monthly.reduce((a, b) => a + b, 0) / Math.max(r.monthly.length, 1)
    const mean = avg
    const sd = Math.sqrt(r.monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(r.monthly.length, 1))
    const t = sd > 0 && r.monthly.length > 1 ? (mean / sd) * Math.sqrt(r.monthly.length) : 0
    const yrs = Object.entries(r.yearly).sort().map(([y, v]) => `${y}:${v >= 0 ? '+' : ''}${v.toFixed(0)}%`).join('  ')
    console.log(`${label.padEnd(24)} full ${r.full >= 0 ? '+' : ''}${r.full.toFixed(1)}%  mUp ${up}/${r.monthly.length}  avg ${avg.toFixed(2)}%/mo  t ${t.toFixed(2)}  | ${yrs}  | bhBasket ${r.bhBasket.toFixed(0)}%  bhBTC ${r.bhBtc.toFixed(0)}%`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })