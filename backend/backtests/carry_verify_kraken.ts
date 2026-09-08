import fs from 'node:fs'

// Funding-carry verification on KRAKEN data (venue of record per project rule).
// Kraken REST exposes the last ~1y of HOURLY funding rates per perp (no
// pagination). This re-verifies the always-receive carry edge on the actual
// venue we trade, for the window we trade in.

const C = '/home/amos-neri/Projects/syphon/backend/backtests/cache'
const PERPS: Record<string, string> = {
  BTC: 'PF_XBTUSD', ETH: 'PF_ETHUSD', XRP: 'PF_XRPUSD', ADA: 'PF_ADAUSD',
  DOGE: 'PF_DOGEUSD', LINK: 'PF_LINKUSD', LTC: 'PF_LTCUSD',
}

interface Rate { time: number; rate: number }

async function fetchKrakenFunding(perp: string): Promise<Rate[]> {
  const url = `https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=${perp}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`kraken funding ${res.status} ${perp}`)
  const json = (await res.json()) as { result?: string; rates?: Array<{ timestamp: string; relativeFundingRate: number }> }
  if (json.result !== 'success' || !json.rates) throw new Error(`bad response ${perp}`)
  return json.rates.map((r) => ({ time: Date.parse(r.timestamp), rate: r.relativeFundingRate }))
}

function analyze(label: string, rates: Rate[]) {
  const byMo = new Map<string, number[]>()
  for (const r of rates) {
    const mo = new Date(r.time).toISOString().slice(0, 7)
    if (!byMo.has(mo)) byMo.set(mo, [])
    byMo.get(mo)!.push(r.rate)
  }
  const months = [...byMo.keys()].sort()
  const monthly = months.map((k) => byMo.get(k)!.reduce((a, b) => a + b, 0) * 100) // in %
  const yearly: Record<string, number> = {}
  for (const k of months) yearly[k.slice(0, 4)] = (yearly[k.slice(0, 4)] || 0) + byMo.get(k)!.reduce((a, b) => a + b, 0) * 100
  const cum = monthly.reduce((a, b) => a + b, 0)
  const up = monthly.filter((m) => m > 0).length
  const mean = monthly.reduce((a, b) => a + b, 0) / Math.max(monthly.length, 1)
  const sd = Math.sqrt(monthly.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(monthly.length, 1))
  const t = sd > 0 && monthly.length > 1 ? (mean / sd) * Math.sqrt(monthly.length) : 0
  const worst = Math.min(...monthly)
  let streak = 0, maxStreak = 0
  for (const m of monthly) { if (m < 0) { streak++; maxStreak = Math.max(maxStreak, streak) } else streak = 0 }
  const yrs = Object.entries(yearly).sort().map(([y, v]) => `${y}:${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join('  ')
  console.log(`${label.padEnd(6)} cum ${cum >= 0 ? '+' : ''}${cum.toFixed(1)}%  avg ${mean.toFixed(2)}%/mo  t ${t.toFixed(2)}  up ${up}/${monthly.length}  worst ${worst.toFixed(1)}%  negStreak ${maxStreak}`)
  console.log(`       ${yrs}`)
  return { monthly }
}

async function loadAll(): Promise<Record<string, Rate[]>> {
  const all: Record<string, Rate[]> = {}
  for (const [sym, perp] of Object.entries(PERPS)) {
    const cacheFile = `${C}/${perp}_funding_1y.json`
    if (fs.existsSync(cacheFile)) {
      all[sym] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    } else {
      const r = await fetchKrakenFunding(perp)
      fs.writeFileSync(cacheFile, JSON.stringify(r))
      all[sym] = r
    }
  }
  return all
}

async function main() {
  const all = await loadAll()
  const first = Math.max(...Object.values(all).map((r) => r[0]?.time ?? 0))
  console.log(`Kraken funding verification — ${Object.keys(PERPS).length} perps, window ${new Date(first).toISOString().slice(0, 10)} → now (${Math.round((Date.now() - first) / 86_400_000)}d)\n`)
  for (const [sym, rates] of Object.entries(all)) analyze(sym, rates)

  // Composite: align by hourly timestamp.
  const comp = new Map<number, number[]>()
  for (const rates of Object.values(all)) for (const r of rates) {
    if (!comp.has(r.time)) comp.set(r.time, [])
    comp.get(r.time)!.push(r.rate)
  }
  const compRates: Rate[] = []
  for (const [time, rates] of comp) compRates.push({ time, rate: rates.reduce((a, b) => a + b, 0) / rates.length })
  compRates.sort((a, b) => a.time - b.time)
  console.log('')
  analyze('COMP', compRates)
}
main().catch((e) => { console.error(e); process.exit(1) })