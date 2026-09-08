import fs from 'node:fs'

// Rigorous funding-carry verification (research phase).
// Universe: USDⓈ-M perps. Models:
//   A. always-receive funding (delta-neutral: spot long + perp short)
//   B. upper bound: receive |rate| every settlement (sign-perfect flip)
//   C. monthly sign-flip overlay: pick the side with positive trailing
//      funding; costs applied per flip
//   D. regime stress: worst month, negative-rate streaks, months with rate<0
//   E. return on margin (perp side margined, e.g. 25%)

const C = '/home/amos-neri/Projects/syphon/backend/backtests/cache'
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'LTCUSDT']
const DAYS = 1095

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

const HOUR = 3600_000
const MONTH_MS = 30.44 * 24 * HOUR

function seriesStats(funds: Fund[], label: string, opts: { entryCost?: number; flip?: boolean; flipCost?: number } = {}) {
  const { entryCost = 0, flip = false, flipCost = 0.004 } = opts
  // Build monthly buckets (calendar month by settlement time).
  const byMo = new Map<string, number[]>()
  for (const f of funds) {
    const mo = new Date(f.time).toISOString().slice(0, 7)
    if (!byMo.has(mo)) byMo.set(mo, [])
    byMo.get(mo)!.push(f.rate)
  }
  const months = [...byMo.keys()].sort()
  const monthlyNet: number[] = []
  const yearly: Record<string, number> = {}
  let side = 1 // +1 = receive (short perp hedged), -1 = pay/reverse
  let totalCost = 0
  for (let i = 0; i < months.length; i++) {
    const rates = byMo.get(months[i])!
    let sum = 0
    if (flip) {
      // Decide side for next month from trailing 30d funding sign.
      const history = funds.filter((f) => f.time >= new Date(months[i]).getTime() - 30 * 24 * HOUR && f.time < new Date(months[i]).getTime())
      const trail = history.reduce((a, f) => a + f.rate, 0)
      const target = trail >= 0 ? 1 : -1
      if (target !== side) { totalCost += flipCost; side = target }
    }
    for (const r of rates) sum += side * r
    const mret = sum * 100
    monthlyNet.push(mret)
    yearly[months[i].slice(0, 4)] = (yearly[months[i].slice(0, 4)] || 0) + mret
  }
  // Amortize one-time entry cost over the run as a flat monthly drag.
  if (entryCost > 0) for (let i = 0; i < monthlyNet.length; i++) monthlyNet[i] -= (entryCost * 100) / monthlyNet.length
  const up = monthlyNet.filter((m) => m > 0).length
  const mean = monthlyNet.reduce((a, b) => a + b, 0) / Math.max(monthlyNet.length, 1)
  const sd = Math.sqrt(monthlyNet.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(monthlyNet.length, 1))
  const t = sd > 0 && monthlyNet.length > 1 ? (mean / sd) * Math.sqrt(monthlyNet.length) : 0
  const cum = monthlyNet.reduce((a, b) => a + b, 0)
  const yrs = Object.entries(yearly).sort().map(([y, v]) => `${y.slice(0, 4)}:${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join('  ')
  const worst = Math.min(...monthlyNet)
  const negMonths = monthlyNet.filter((m) => m < 0).length
  let streak = 0, maxStreak = 0
  for (const m of monthlyNet) { if (m < 0) { streak++; maxStreak = Math.max(maxStreak, streak) } else streak = 0 }
  return { label, cum, avg: mean, t, up, n: monthlyNet.length, worst, negMonths, maxStreak, yrs, monthly: monthlyNet }
}

async function main() {
  const start = Date.now() - DAYS * 24 * HOUR
  const all = new Map<string, Fund[]>()
  for (const sym of SYMS) {
    const cacheFile = `${C}/${sym}_funding_3y.json`
    let funds: Fund[]
    if (fs.existsSync(cacheFile)) funds = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    else {
      funds = await fetchFunding(sym, start)
      fs.writeFileSync(cacheFile, JSON.stringify(funds))
    }
    all.set(sym, funds.filter((f) => f.time >= start))
  }

  console.log(`funding carry verification — ${SYMS.length} perps, ${DAYS}d\n`)
  // Per-asset: always-receive net of one-time entry (0.3%) + regime stats.
  for (const sym of SYMS) {
    const funds = all.get(sym)!
    const s = seriesStats(funds, sym, { entryCost: 0.003 })
    console.log(`${sym.padEnd(10)} cum ${s.cum >= 0 ? '+' : ''}${s.cum.toFixed(1)}%  avg ${s.avg.toFixed(2)}%/mo  t ${s.t.toFixed(2)}  up ${s.up}/${s.n}  worst ${s.worst.toFixed(1)}%  neg ${s.negMonths}  streak ${s.maxStreak}  | ${s.yrs}`)
  }

  // Composite: aligned settlements, equal weight.
  const comp = new Map<number, number[]>()
  for (const funds of all.values()) for (const f of funds) {
    if (!comp.has(f.time)) comp.set(f.time, [])
    comp.get(f.time)!.push(f.rate)
  }
  const compFunds: Fund[] = []
  for (const [time, rates] of comp) compFunds.push({ time, rate: rates.reduce((a, b) => a + b, 0) / rates.length })
  compFunds.sort((a, b) => a.time - b.time)

  const base = seriesStats(compFunds, 'COMPOSITE', { entryCost: 0.003 })
  console.log(`\nCOMPOSITE (11 perps, equal weight):`)
  console.log(`  always-receive: cum ${base.cum >= 0 ? '+' : ''}${base.cum.toFixed(1)}%  avg ${base.avg.toFixed(2)}%/mo  t ${base.t.toFixed(2)}  up ${base.up}/${base.n}  worst ${base.worst.toFixed(1)}%  neg ${base.negMonths}/${base.n}  streak ${base.maxStreak}`)

  // Upper bound: |rate| every settlement (perfect side-switching).
  const absFunds: Fund[] = compFunds.map((f) => ({ ...f, rate: Math.abs(f.rate) }))
  const ub = seriesStats(absFunds, 'UPPERBOUND')
  console.log(`  upper bound (|rate|): cum ${ub.cum >= 0 ? '+' : ''}${ub.cum.toFixed(1)}%  avg ${ub.avg.toFixed(2)}%/mo  t ${ub.t.toFixed(2)}  up ${ub.up}/${ub.n}`)

  // Monthly sign-flip overlay with costs.
  for (const cost of [0.002, 0.004]) {
    const flip = seriesStats(compFunds, `FLIP@${(cost * 100).toFixed(1)}%`, { flip: true, flipCost: cost, entryCost: 0.003 })
    console.log(`  sign-flip monthly (${(cost * 100).toFixed(1)}%/flip): cum ${flip.cum >= 0 ? '+' : ''}${flip.cum.toFixed(1)}%  avg ${flip.avg.toFixed(2)}%/mo  t ${flip.t.toFixed(2)}  up ${flip.up}/${flip.n}  worst ${flip.worst.toFixed(1)}%  neg ${flip.negMonths}/${flip.n}  | ${flip.yrs}`)
  }

  // Return on margin: perp short margined at 25% of notional → per-margin carry.
  const marginPct = 0.25
  console.log(`\nReturn on margin (perp side at ${marginPct * 100}% notional):`)
  console.log(`  composite always-receive: ~${(base.avg / marginPct).toFixed(2)}%/mo on margin (${((base.cum / marginPct)).toFixed(1)}% cum) — before funding-costs-of-margin (borrow)`)
}
main().catch((e) => { console.error(e); process.exit(1) })