import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import AlgoConfig from '#models/AlgoConfig'
import { fastStrategyFromConfig, FastStrategyConfig } from '#services/FastStrategy'
import { BacktestEngine, BacktestConfig, BacktestResult, BacktestSample } from '#services/BacktestEngine'
import { fetchBinanceKlines1s } from '#services/BinanceKlineService'
import { buildSweepList } from './backtest_sweep.js'

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

// Walk-forward: sweep the grid on window N, validate the winner on window
// N+1 (out-of-sample). A config whose out-of-sample PF collapses fails —
// this is what caught swing's PF 3.92 -> 0.18 noise.
//
// Windows are ordered oldest -> newest: window 0 ends `(windows-1)*hours`
// hours ago, the last window ends now.

export default class BacktestWalkforward extends BaseCommand {
  static commandName = 'backtest:walkforward'
  static description = 'Sweep + validate configs across consecutive windows (walk-forward)'
  static options = { startApp: true }

  @flags.string({ description: 'Symbol (default BTC)' })
  declare symbol: string

  @flags.number({ description: 'Hours per window (default 72, max 72)' })
  declare hours: number

  @flags.number({ description: 'Number of consecutive windows (default 3)' })
  declare windows: number

  @flags.number({ description: 'Minimum trades for a row to rank (default 10)' })
  declare minTrades: number

  @flags.number({ description: 'Out-of-sample pass threshold: min PF (default 1.2)' })
  declare minPf: number

  @flags.string({ description: 'JSON overrides applied to the baseline before sweeping' })
  declare config: string

  @flags.boolean({ description: 'Skip the cache and refetch from Binance' })
  declare fresh: boolean

  async run() {
    const symbol = (this.symbol || 'BTC').toUpperCase()
    const hours = Math.min(Math.max(this.hours || 72, 6), 72)
    const windowCount = Math.min(Math.max(this.windows || 3, 2), 6)
    const minTrades = this.minTrades || 10
    const minPf = this.minPf || 1.2

    const cfg = await AlgoConfig.getConfig()
    const overrides: Record<string, any> = this.config ? JSON.parse(this.config) : {}
    const pick = (keys: string[]) => {
      const out: Record<string, any> = {}
      for (const k of keys) out[k] = (cfg as any)[k]
      return out
    }
    const merged = {
      ...pick([
        'fastMomentumSeconds', 'fastMomentumThresholdPct', 'fastRsiLow', 'fastRsiHigh',
        'fastStopLossPct', 'fastTakeProfitPct', 'fastExitReversalPct',
        'fastTrailingStopPct', 'fastTrailingActivatePct', 'fastMaxHoldSeconds',
        'fastEmaPeriod', 'fastVolatilityWindowSeconds', 'fastVolatilityMult',
        'fastVolatilityFloorPct', 'fastVolatilityCeilingPct',
        'fastTrendMode', 'fastTrendSlopePct', 'fastTrendSlopeWindowSeconds',
        'fastRegimeEmaPeriod', 'fastRegimeSlopeWindowSeconds', 'fastRegimeSlopeMinPct',
        'fastVolumeWindowSeconds', 'fastVolumeMinRatio',
        'fastCorrelatedExposurePct', 'fastRiskPerTradePct', 'fastMaxLossStreak',
        'fastLossStreakPauseSeconds', 'fastTrailingVolatilityMult', 'fastScaleOutPct',
        'fastCooldownSeconds', 'maxPositions', 'maxExposurePct', 'maxSinglePositionPct',
        'fastIntervalSeconds',
      ]),
      ...overrides,
    }
    const base = fastStrategyFromConfig(merged)
    const engine = new BacktestEngine()

    // Windows oldest -> newest.
    const endTimes: number[] = []
    for (let i = windowCount - 1; i >= 0; i--) {
      endTimes.push(Date.now() - i * hours * 3600_000)
    }

    const windows = await Promise.all(
      endTimes.map((endTime, index) => this.loadSamples(symbol, endTime - hours * 3600_000, endTime, hours, index))
    )

    const baseConfig = (strategy: FastStrategyConfig): BacktestConfig => ({
      symbol,
      strategy,
      loopIntervalSeconds: merged.fastIntervalSeconds || 10,
      portfolioUsd: 10_000,
      feePct: 0.0026,
      maxPositions: merged.maxPositions,
      maxExposurePct: merged.maxExposurePct,
      maxSinglePositionPct: merged.maxSinglePositionPct,
      cooldownSeconds: merged.fastCooldownSeconds,
      correlatedExposurePct: merged.fastCorrelatedExposurePct,
      riskPerTradePct: merged.fastRiskPerTradePct,
      maxLossStreak: merged.fastMaxLossStreak,
      lossStreakPauseSeconds: merged.fastLossStreakPauseSeconds,
    })

    this.logger.info('')
    this.logger.info(`=== Walk-forward: ${symbol} ${windowCount}×${hours}h (oldest -> newest) ===`)

    interface Verdict {
      trainIdx: number
      winner: string
      isTrades: number
      isPf: number
      isNet: number
      oosTrades: number
      oosPf: number
      oosNet: number
      pass: boolean
    }
    const verdicts: Verdict[] = []

    for (let i = 0; i < windowCount - 1; i++) {
      const trainSamples = windows[i]
      const oosSamples = windows[i + 1]
      const trainResult = engine.run(trainSamples, baseConfig(base))

      // Rank the grid on this window.
      const ranked: Array<{ label: string; strategy: FastStrategyConfig; patch: Partial<BacktestConfig>; result: BacktestResult }> = []
      for (const row of buildSweepList(base)) {
        const result = engine.run(trainSamples, { ...baseConfig(row.strategy), ...row.patch })
        if (result.metrics.totalTrades < minTrades) continue
        ranked.push({ ...row, result })
      }
      ranked.sort((a, b) => {
        const pf = (b.result.metrics.profitFactor === Infinity ? 999 : b.result.metrics.profitFactor)
          - (a.result.metrics.profitFactor === Infinity ? 999 : a.result.metrics.profitFactor)
        return pf
      })

      if (ranked.length === 0) {
        this.logger.info(`Window ${i}: no config passed min-trades (${minTrades}). Skipping.`)
        continue
      }

      const winner = ranked[0]
      const oosResult = engine.run(oosSamples, { ...baseConfig(winner.strategy), ...winner.patch })
      const pass = oosResult.metrics.totalTrades >= minTrades
        && oosResult.metrics.profitFactor >= minPf
        && oosResult.strategyReturnPct > 0

      verdicts.push({
        trainIdx: i,
        winner: winner.label,
        isTrades: winner.result.metrics.totalTrades,
        isPf: winner.result.metrics.profitFactor,
        isNet: winner.result.strategyReturnPct,
        oosTrades: oosResult.metrics.totalTrades,
        oosPf: oosResult.metrics.profitFactor,
        oosNet: oosResult.strategyReturnPct,
        pass,
      })

      const fmt = (v: number) => (v === Infinity ? 'inf' : v.toFixed(2))
      this.logger.info(`Train w${i} (${trainSamples.length} samples): live config PF ${fmt(trainResult.metrics.profitFactor)} net ${trainResult.strategyReturnPct.toFixed(2)}%`)
      this.logger.info(`  winner: ${winner.label}  IS ${winner.result.metrics.totalTrades}t PF ${fmt(winner.result.metrics.profitFactor)} net ${winner.result.strategyReturnPct >= 0 ? '+' : ''}${winner.result.strategyReturnPct.toFixed(2)}%`)
      this.logger.info(`  OOS w${i + 1}: ${oosResult.metrics.totalTrades}t PF ${fmt(oosResult.metrics.profitFactor)} net ${oosResult.strategyReturnPct >= 0 ? '+' : ''}${oosResult.strategyReturnPct.toFixed(2)}%  ${pass ? 'PASS' : 'FAIL'} (need PF>=${minPf}, net>0, >=${minTrades}t)`)
      this.logger.info(`  top-5 runners-up:`)
      ranked.slice(1, 5).forEach((r, idx) => {
        this.logger.info(`    ${idx + 2}. ${r.label}  ${r.result.metrics.totalTrades}t PF ${fmt(r.result.metrics.profitFactor)} net ${r.result.strategyReturnPct >= 0 ? '+' : ''}${r.result.strategyReturnPct.toFixed(2)}%`)
      })
    }

    this.logger.info('')
    this.logger.info('=== Verdicts ===')
    for (const v of verdicts) {
      const fmt = (n: number) => (n === Infinity ? 'inf' : n.toFixed(2))
      this.logger.info(`w${v.trainIdx} -> w${v.trainIdx + 1}: ${v.winner}  IS ${v.isTrades}t PF ${fmt(v.isPf)} net ${v.isNet >= 0 ? '+' : ''}${v.isNet.toFixed(2)}%  |  OOS ${v.oosTrades}t PF ${fmt(v.oosPf)} net ${v.oosNet >= 0 ? '+' : ''}${v.oosNet.toFixed(2)}%  ${v.pass ? 'PASS' : 'FAIL'}`)
    }
  }

  private async loadSamples(
    symbol: string,
    startTime: number,
    endTime: number,
    hours: number,
    index: number
  ): Promise<BacktestSample[]> {
    const cacheFile = path.join(CACHE_DIR, `${symbol}_1s_${hours}h_wf${index}_v2.json`)
    if (!this.fresh && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Loaded ${raw.length} cached samples from ${cacheFile}`)
        return raw
      } catch (err) {
        this.logger.warn(`Cache unreadable, refetching: ${(err as Error).message}`)
      }
    }
    this.logger.info(`Fetching ${hours}h of 1s klines for ${symbol} (window ${index})…`)
    const samples = await fetchBinanceKlines1s(symbol, startTime, endTime)
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(cacheFile, JSON.stringify(samples))
      this.logger.info(`Cached ${samples.length} samples to ${cacheFile}`)
    } catch (err) {
      this.logger.warn(`Failed to cache samples: ${(err as Error).message}`)
    }
    return samples
  }
}
