import fs from 'node:fs'
import type { FastStrategyConfig } from '/home/amos-neri/Projects/syphon/backend/app/services/FastStrategy.js'
import { BacktestEngine, BacktestConfig, BacktestSample } from '/home/amos-neri/Projects/syphon/backend/app/services/BacktestEngine.js'
import { dailyTrendStrategy } from '/home/amos-neri/Projects/syphon/backend/app/services/DailyTrendProduct.js'

const C = '/home/amos-neri/Projects/syphon/backend/backtests/cache'
function toBars(raw: BacktestSample[], sec: number): BacktestSample[] {
  const out: BacktestSample[] = []
  let cur: BacktestSample | null = null
  for (const s of raw) {
    if (!cur || s.t - cur.t >= sec * 1000) { cur = { t: s.t, p: s.p, h: s.h, l: s.l }; out.push(cur) }
    else { cur.p = s.p; cur.h = Math.max(cur.h!, s.h!); cur.l = Math.min(cur.l!, s.l!) }
  }
  return out
}
const engine = new BacktestEngine()
const mkCfg = (symbol: string, s: FastStrategyConfig, loop: number): BacktestConfig => ({
  symbol, strategy: s, loopIntervalSeconds: loop, portfolioUsd: 10_000, feePct: 0.0026,
  maxPositions: 1, maxExposurePct: 0.9, maxSinglePositionPct: 0.9, cooldownSeconds: 0, slippageBps: 10,
})
function yearly(result: { equityCurve: Array<{ t: number; value: number }> }): string {
  const byMonth = new Map<string, [number, number]>()
  for (let i = 1; i < result.equityCurve.length; i++) {
    const k = new Date(result.equityCurve[i].t).toISOString().slice(0, 7)
    const p = byMonth.get(k)
    if (!p) byMonth.set(k, [result.equityCurve[i - 1].value, result.equityCurve[i].value])
    else p[1] = result.equityCurve[i].value
  }
  const yrs = new Map<string, number[]>()
  for (const [k, [a, b]] of byMonth) {
    if (a > 0 && b >= 0) { const y = k.slice(0, 4); if (!yrs.has(y)) yrs.set(y, []); yrs.get(y)!.push(((b - a) / a) * 100) }
  }
  return [...yrs.entries()].sort().map(([y, rs]) => `${y}: ${rs.reduce((x, z) => x + z, 0).toFixed(1)}%`).join('  ')
}
async function main() {
  const symbol = process.argv[2] || 'BTC'
  const raw = JSON.parse(fs.readFileSync(`${C}/${symbol}_1m_1095d.json`, 'utf8')) as BacktestSample[]
  const d5 = toBars(raw, 300)
  const variants: Array<[string, FastStrategyConfig, BacktestSample[], number]> = [
    ['5m bars + trail    ', dailyTrendStrategy(300), d5, 300],
    ['1m bars + trail    ', dailyTrendStrategy(60), raw, 60],
    ['1m bars, NO trail  ', { ...dailyTrendStrategy(60), trailingStopPct: 0, trailingActivatePct: 0 }, raw, 60],
    ['1m bars, no trail SL10', { ...dailyTrendStrategy(60), trailingStopPct: 0, trailingActivatePct: 0, stopLossPct: 10 }, raw, 60],
  ]
  for (const [label, s, samples, loop] of variants) {
    const r = engine.run(samples, mkCfg(symbol, s, loop))
    console.log(`${label}: net ${r.strategyReturnPct.toFixed(1)}%  t${r.metrics.totalTrades} WR${(r.metrics.winRate * 100).toFixed(0)}  PF${r.metrics.profitFactor === Infinity ? 'inf' : r.metrics.profitFactor.toFixed(2)}  maxDD ${r.metrics.maxDrawdownPct.toFixed(1)}%`)
    console.log(`    ${yearly(r)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
