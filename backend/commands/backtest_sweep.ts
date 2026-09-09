import { BaseCommand } from '@adonisjs/core/ace'
import * as fs from 'node:fs'
import * as path from 'node:path'
import db from '@adonisjs/lucid/services/db'
import AlgoConfig from '#models/AlgoConfig'
import { BacktestEngine, BacktestSample } from '#services/BacktestEngine'
import { fastStrategyFromConfig, FastStrategyConfig } from '#services/FastStrategy'
import KrakenDataService from '#services/KrakenDataService'
import { clamp } from '#app/utils/backtest_flags'

// One-at-a-time parameter sweep around the live config (+ presets), ranked
// by profit factor with a min-trades filter. PF ranking is multiple-testing
// biased — the t-stat column is the honest signal measure; treat grid
// winners as candidates, not verdicts.

const CACHE_DIR = path.join(import.meta.dirname, '..', 'backtests', 'cache', 'kraken')

const GRID_MULTIPLIERS = [0.5, 0.75, 1.25, 1.5]

const SWEEP_FIELDS: Array<[string, (n: number) => number]> = [
  ['fastStopLossPct', (v) => v],
  ['fastTakeProfitPct', (v) => v],
  ['fastTrailingStopPct', (v) => v],
  ['fastTrailingActivatePct', (v) => v],
  ['fastMomentumSeconds', (v) => Math.round(v)],
  ['fastMomentumThresholdPct', (v) => v],
  ['fastEmaPeriod', (v) => Math.round(v)],
  ['fastCooldownSeconds', (v) => Math.round(v)],
  ['fastExitReversalPct', (v) => v],
  ['fastTrendSlopePct', (v) => v],
]

const PRESETS: Record<string, Record<string, any>> = {
  scalp: {
    fastMomentumSeconds: 30, fastMomentumThresholdPct: 0.3,
    fastStopLossPct: 0.3, fastTakeProfitPct: 0.8,
    fastTrailingStopPct: 0.3, fastTrailingActivatePct: 0.3,
    fastEmaPeriod: 10, fastCooldownSeconds: 120, fastExitReversalPct: -0.2,
  },
  trend: {
    fastMomentumSeconds: 120, fastMomentumThresholdPct: 0.3,
    fastStopLossPct: 1.2, fastTakeProfitPct: 3.0,
    fastTrailingStopPct: 0.5, fastTrailingActivatePct: 0.8,
    fastEmaPeriod: 40, fastCooldownSeconds: 300, fastExitReversalPct: -0.5,
  },
  swing: {
    fastTrendMode: true, fastEmaPeriod: 900, fastTrendSlopePct: 0.05,
    fastTrendSlopeWindowSeconds: 1800, fastRegimeEmaPeriod: 3600,
    fastRegimeSlopeWindowSeconds: 3600, fastRegimeSlopeMinPct: 0.02,
    fastStopLossPct: 1.5, fastTakeProfitPct: 0,
    fastTrailingStopPct: 0.6, fastTrailingActivatePct: 1.0,
    fastCooldownSeconds: 600, fastExitReversalPct: -1.0,
  },
}

function tStat(pnlPcts: number[]): number {
  const n = pnlPcts.length
  if (n < 2) return 0
  const mean = pnlPcts.reduce((s, v) => s + v, 0) / n
  const variance = pnlPcts.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
  const sd = Math.sqrt(variance)
  return sd === 0 ? (mean > 0 ? Infinity : -Infinity) : (mean / sd) * Math.sqrt(n)
}

export default class BacktestSweep extends BaseCommand {
  static commandName = 'backtest:sweep'
  static description = 'One-at-a-time parameter sweep around the live algo config (Kraken data)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Ticker symbol (default BTC)' },
    { flagName: 'interval', name: 'interval', type: 'number', description: 'Bar seconds: 1|60|... (default 1)' },
    { flagName: 'hours', name: 'hours', type: 'number', description: 'Window in hours (default 24)' },
    { flagName: 'fresh', name: 'fresh', type: 'boolean', description: 'Re-fetch OHLC instead of using the cache' },
    { flagName: 'minTrades', name: 'minTrades', type: 'number', description: 'Minimum trades to rank a config (default 5)' },
    { flagName: 'top', name: 'top', type: 'number', description: 'How many results to show (default 15)' },
  ]

  async run() {
    const symbol = (this.parsed.flags.symbol || 'BTC').toUpperCase()
    const intervalSeconds = Number(this.parsed.flags.interval ?? 1)
    const hours = Number(this.parsed.flags.hours ?? 24)
    const fresh = Boolean(this.parsed.flags.fresh)
    const minTrades = Number(this.parsed.flags.minTrades ?? 5)
    const topN = Number(this.parsed.flags.top ?? 15)

    // Data load (shared with backtest).
    let samples: BacktestSample[]
    if (intervalSeconds === 1) {
      const start = Date.now() - hours * 3600_000
      const rows = await db.from('tick_records')
        .where('symbol', symbol).where('ts', '>=', start).orderBy('ts', 'asc')
      samples = rows.map((r) => ({ t: Number(r.ts), p: Number(r.close), h: Number(r.high), l: Number(r.low), v: Number(r.volume) }))
    } else {
      const intervalMin = intervalSeconds / 60
      const file = path.join(CACHE_DIR, `${symbol}_${intervalMin}m_${hours}h.json`)
      if (!fresh && fs.existsSync(file)) {
        samples = JSON.parse(fs.readFileSync(file, 'utf8')).samples
      } else {
        const candles = await KrakenDataService.walkOHLC(symbol, intervalMin, Date.now() - hours * 3600_000)
        fs.mkdirSync(CACHE_DIR, { recursive: true })
        samples = candles
          .filter((c) => c.time * 1000 >= Date.now() - hours * 3600_000)
          .map((c) => ({ t: c.time * 1000, p: c.close, h: c.high, l: c.low, v: c.volume }))
        fs.writeFileSync(file, JSON.stringify({ symbol, intervalMin, fetchedAt: new Date().toISOString(), samples }))
      }
    }

    const config = await AlgoConfig.getConfig()
    const baseRaw: Record<string, any> = { ...config.$attributes }
    const loopSeconds = clamp(baseRaw.fastIntervalSeconds || 10, 5, 300)

    const engine = new BacktestEngine()
    const runCfg = (raw: Record<string, any>) => ({
      strategy: fastStrategyFromConfig({ ...baseRaw, ...raw }, { sampleIntervalSeconds: intervalSeconds }),
      symbol,
      loopIntervalSeconds: loopSeconds,
      portfolioUsd: 10_000,
      feePct: Number(baseRaw.fastMakerFeePct ?? 0.0026),
      maxPositions: clamp(baseRaw.maxPositions || 1, 1, 50),
      maxExposurePct: clamp(baseRaw.maxExposurePct || 0.8, 0.1, 1),
      maxSinglePositionPct: clamp(baseRaw.maxSinglePositionPct || 0.15, 0.01, 0.5),
      cooldownSeconds: clamp((baseRaw.fastCooldownSeconds ?? 180) as number, 10, 3600),
      correlatedExposurePct: baseRaw.fastCorrelatedExposurePct || 0,
      riskPerTradePct: baseRaw.fastRiskPerTradePct || 0,
      maxLossStreak: baseRaw.fastMaxLossStreak || 0,
      lossStreakPauseSeconds: baseRaw.fastLossStreakPauseSeconds || 0,
      slippageBps: baseRaw.fastSlippageBps || 0,
    })

    const results: Array<{ label: string; strat: FastStrategyConfig; ret: number; trades: number; wr: number; pf: number; tstat: number; dd: number }> = []

    const run = (label: string, raw: Record<string, any>) => {
      const r = engine.run(samples, runCfg(raw) as any)
      const pnlPcts = r.trades.filter((t) => !t.partial).map((t) => t.pnlPct)
      results.push({
        label,
        strat: runCfg(raw).strategy,
        ret: r.strategyReturnPct,
        trades: r.metrics.totalTrades,
        wr: r.metrics.winRate,
        pf: r.metrics.profitFactor,
        tstat: tStat(pnlPcts),
        dd: r.metrics.maxDrawdownPct,
      })
    }

    // Baseline.
    run('baseline', {})

    // One-at-a-time grid around the live value.
    for (const [field, round] of SWEEP_FIELDS) {
      const live = Number(baseRaw[field] ?? 0)
      if (live <= 0) continue
      for (const mult of GRID_MULTIPLIERS) {
        const value = round(live * mult)
        if (value === live) continue
        run(`${field}=${value}`, { [field]: value })
      }
    }

    // Presets.
    for (const [name, overrides] of Object.entries(PRESETS)) {
      run(`preset:${name}`, overrides)
    }

    // Rank by PF, filtered by min trades.
    const ranked = results
      .filter((r) => r.trades >= minTrades && Number.isFinite(r.pf))
      .sort((a, b) => b.pf - a.pf)
      .slice(0, topN)

    this.logger.info('')
    this.logger.info(`═══ Sweep ${symbol} ${intervalSeconds}s bars / ${hours}h — top ${ranked.length} by PF (min ${minTrades} trades) ═══`)
    for (const r of ranked) {
      this.logger.info(`${r.label.padEnd(28)}  ret=${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(2)}%  trades=${String(r.trades).padStart(3)}  WR=${(r.wr * 100).toFixed(0)}%  PF=${r.pf.toFixed(2)}  t=${r.tstat.toFixed(2)}  DD=${r.dd.toFixed(2)}%`)
    }
  }
}