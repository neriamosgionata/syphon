import fs from 'node:fs'

// Regime stress test for the funding-carry rule.
// Pulls the FULL Binance USDⓈ-M funding history per symbol (back to the
// perp launch, ~2019-11) — the 2020-03 crash (deeply negative funding) and
// the 2022 bear (extended low/negative funding) are inside this window.
//
// Simulates:
//   A. naive always-receive (hold the receiving side every settlement)
//   B. halt rule from the paper service: stand aside when trailing 30d
//      funding < 0, resume when it turns positive again (monthly cadence,
//      0.4% flip cost each way)
//   C. report negative-funding episodes (worst month, longest streak)

const C = '/home/amos-neri/Projects/syphon/backend/backtests/cache'
const SYMS = ['XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT']
const HOUR = 3600_000
const DAY = 24 * HOUR

interface Fund { time: number; rate: number }

async function fetchFunding(sym: string, startMs: number): Promise<Fund[]> {
  const out: Fund[] = []
  let cursor = startMs
  while (cursor < Date.now()) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${cursor}&limit=1000`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`funding ${res.status} ${sym}`)
    const json = (await res.json()) as any[]
    if (!json.length) break
    for (const row of json) out.push({ time: Number(row.fundingTime), rate: Number(row.fundingRate) })
    const last = Number(json[json.length - 1].fundingTime)
    if (last <= cursor) break
    cursor = last + 1
    await new Promise((r) => setTimeout(r, 110))
  }
  return out
}

function toMonthly(funds: Fund[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const f of funds) {
    const k = new Date(f.time).toISOString().slice(0, 7)
    m.set(k, (m.get(k) || 0) + f.rate)
  }
  return m
}

function stats(label: string, months: Map<string, number>) {
  const keys = [...months.keys()].sort()
  const monthly = keys.map((k) => months.get(k)! * 100)
  const yearly: Record<string, number> = {}
  for (const k of keys) yearly[k.slice(0, 4)] = (yearly[k.slice(0, 4)] || 0) + months.get(k)! * 100
  const cum = monthly.reduce((a, b) => a + b, 0)
  const up = monthly.filter((m) => m > 0).length
  const mean = monthly.reduce((a, b) => a + b, 0) / Math.max(monthly.length, 1)
  const sd = Math.sqrt(monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(monthly.length, 1))
  const t = sd > 0 && monthly.length > 1 ? (mean / sd) * Math.sqrt(monthly.length) : 0
  const worst = Math.min(...monthly)
  let streak = 0, maxStreak = 0
  for (const m of monthly) { if (m < 0) { streak++; maxStreak = Math.max(maxStreak, streak) } else streak = 0 }
  const yrs = Object.entries(yearly).sort().map(([y, v]) => `${y}:${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join('  ')
  console.log(`${label.padEnd(28)} cum ${cum >= 0 ? '+' : ''}${cum.toFixed(1)}%  t ${t.toFixed(2)}  up ${up}/${monthly.length}  worst ${worst.toFixed(1)}%  negStreak ${maxStreak}\n    ${yrs}`)
  return { monthly, cum }
}

/** Halt-rule overlay: stand aside while trailing-30d funding is negative, resume after. */
function withHaltRule(funds: Fund[], months: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  const monthTimes = new Map<string, number[]>()
  for (const f of funds) {
    const k = new Date(f.time).toISOString().slice(0, 7)
    if (!monthTimes.has(k)) monthTimes.set(k, [])
    monthTimes.get(k)!.push(f.time)
  }
  let active = true
  for (const k of [...months.keys()].sort()) {
    const ts = monthTimes.get(k) || []
    const mid = ts[Math.floor(ts.length / 2)] || 0
    // trailing 30d funding ending at this month's midpoint
    const trail = funds.filter((f) => f.time > mid - 30 * DAY && f.time <= mid).reduce((a, f) => a + f.rate, 0)
    const nextActive = trail >= 0
    const flip = active !== nextActive ? 0.004 : 0 // 0.4% flip cost
    out.set(k, (active ? months.get(k)! : 0) - flip)
    active = nextActive
  }
  return out
}

async function main() {
  const start = Date.parse('2019-11-01T00:00:00Z')
  for (const sym of SYMS) {
    const cacheFile = `${C}/${sym}_funding_full.json`
    let funds: Fund[]
    if (fs.existsSync(cacheFile)) funds = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    else {
      funds = await fetchFunding(sym, start)
      fs.writeFileSync(cacheFile, JSON.stringify(funds))
    }
    const months = toMonthly(funds)
    const first = funds[0]
    console.log(`\n=== ${sym} (${new Date(first.time).toISOString().slice(0, 10)} → now, ${funds.length} settlements) ===`)
    stats('always-receive (naive)', months)
    stats('halt-rule overlay (0.4%/flip)', withHaltRule(funds, months))
  }
}
main().catch((e) => { console.error(e); process.exit(1) })