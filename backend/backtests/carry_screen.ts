import fs from 'node:fs'

// Binance USDⓈ-M futures funding history → delta-neutral carry P&L screen.
// Long spot + short perp (or vice versa) of equal notional: price P&L ~0,
// portfolio return ≈ funding rate paid/received per 8h settlement.

const C = '/home/amos-neri/Projects/syphon/backend/backtests/cache'
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

interface Fund { time: number; rate: number }

async function fetchFunding(sym: string, startMs: number): Promise<Fund[]> {
  const out: Fund[] = []
  let cursor = startMs
  while (cursor < Date.now()) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${cursor}&limit=1000`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`funding ${res.status} ${sym}`)
    const json = (await res.json()) as Array<[number, string] | any[]>
    if (!json.length) break
    for (const row of json) out.push({ time: Number(row.fundingTime ?? row[0]), rate: Number(row.fundingRate ?? row[1]) })
    const last = Number(json[json.length - 1].fundingTime ?? json[json.length - 1][0])
    if (last <= cursor) break
    cursor = last + 1
    await new Promise((r) => setTimeout(r, 120))
  }
  return out
}

function monthlyStats(series: Array<{ time: number; rate: number }>, label: string) {
  const byMo = new Map<string, number>()
  for (const f of series) {
    const mo = new Date(f.time).toISOString().slice(0, 7)
    byMo.set(mo, (byMo.get(mo) || 0) + f.rate)
  }
  const keys = [...byMo.keys()].sort()
  const monthly = keys.map((k) => byMo.get(k)! * 100)
  const yearly: Record<string, number> = {}
  for (const k of keys) yearly[k.slice(0, 4)] = (yearly[k.slice(0, 4)] || 0) + byMo.get(k)! * 100
  const up = monthly.filter((m) => m > 0).length
  const mean = monthly.reduce((a, b) => a + b, 0) / Math.max(monthly.length, 1)
  const sd = Math.sqrt(monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(monthly.length, 1))
  const t = sd > 0 && monthly.length > 1 ? (mean / sd) * Math.sqrt(monthly.length) : 0
  const cum = monthly.reduce((a, b) => a + b, 0)
  const yrs = Object.entries(yearly).sort().map(([y, v]) => `${y}:${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join('  ')
  console.log(`${label.padEnd(14)} cum ${cum >= 0 ? '+' : ''}${cum.toFixed(1)}%  mUp ${up}/${monthly.length}  avg ${mean.toFixed(2)}%/mo  t ${t.toFixed(2)}  | ${yrs}`)
}

async function main() {
  const start = Date.now() - 1095 * 86_400_000
  for (const sym of SYMS) {
    const cacheFile = `${C}/${sym}_funding_3y.json`
    let funds: Fund[]
    if (fs.existsSync(cacheFile)) funds = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    else {
      funds = await fetchFunding(sym, start)
      fs.writeFileSync(cacheFile, JSON.stringify(funds))
    }
    const since = funds.filter((f) => f.time >= start)
    // Funding P&L for a neutral position of notional 1.0 (0.01% = 1 bp).
    const earned = since.map((f) => ({ time: f.time, rate: f.rate }))
    monthlyStats(earned, sym)
    // Longs-pay when rate>0; "earn when you hold the long" = +rate. We also
    // show the mirror (short side earns -rate) for the opposite bias.
    monthlyStats(earned.map((f) => ({ ...f, rate: -f.rate })), `${sym} (short)`)
  }
  // Composite: equal-weight of the three long-earn series.
  const comp: Array<{ time: number; rate: number }> = []
  const byTime = new Map<number, number[]>()
  for (const sym of SYMS) {
    const cacheFile = `${C}/${sym}_funding_3y.json`
    const funds = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Fund[]
    for (const f of funds.filter((x) => x.time >= start)) {
      if (!byTime.has(f.time)) byTime.set(f.time, [])
      byTime.get(f.time)!.push(f.rate)
    }
  }
  for (const [time, rates] of byTime) comp.push({ time, rate: rates.reduce((a, b) => a + b, 0) / rates.length })
  monthlyStats(comp, 'COMPOSITE')
}
main().catch((e) => { console.error(e); process.exit(1) })