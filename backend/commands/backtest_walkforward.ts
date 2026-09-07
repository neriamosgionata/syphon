import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import AlgoConfig from '#models/AlgoConfig'
import { fastStrategyFromConfig, FastStrategyConfig } from '#services/FastStrategy'
import { BacktestEngine, BacktestConfig, BacktestResult, BacktestSample } from '#services/BacktestEngine'
import { fetchBinanceKlines } from '#services/BinanceKlineService'
import { buildSweepList } from './backtest_sweep.js'

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

function maxHoursFor(intervalSeconds: number): number {
  return intervalSeconds === 1 ? 504 : 87_600
}

function intervalSecondsFor(raw: string | undefined): number {
  return raw === '1m' ? 60 : 1
}

// Walk-forward: sweep the grid on window N, validate the winner on window
// N+1 (out-of-sample). A config whose out-of-sample PF collapses fails —
// this is what caught swing's PF 3.92 -> 0.18 noise.
//
// Windows are ordered oldest -> newest: window 0 ends `(windows-1)*hours`
// hours ago, the last window ends now.
//
// On coarse bars (--bar-interval=1m) the 1s-tuned sweep grid is not
// interval-agnostic, so no sweep happens: each window simply runs the live
// config and adjacent windows are compared (OOS = the next window's run of
// the SAME config). No IS selection = no multiple-testing bias.

export default class BacktestWalkforward extends BaseCommand {
  static commandName = 'backtest:walkforward'
  static description = 'Sweep + validate configs across consecutive windows (walk-forward)'
  static options = { startApp: true }

  @flags.string({ description: 'Symbol (default BTC)' })
  declare symbol: string

  @flags.string({ description: 'Bar interval: 1s (default) or 1m' })
  declare barInterval: string

  @flags.number({ description: 'Hours per window (default 72, max 504 on 1s, 87600 on 1m)' })
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
    const intervalSeconds = intervalSecondsFor(this.barInterval)
    const coarse = intervalSeconds > 1
    const hours = Math.min(Math.max(this.hours || 72, 1), maxHoursFor(intervalSeconds))
    const windowCount = Math.min(Math.max(this.windows || 3, 2), 12)
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
        'fastMakerExecution', 'fastLimitFillSeconds', 'fastLimitOffsetPct',
        'fastMakerFeePct', 'fastVolTargetPct', 'fastVolTargetWindowSeconds',
        'fastVolTargetMaxMult',
        'fastHarVolForecast', 'fastCusumWindowSeconds', 'fastCusumExitPct',
        'fastJumpSlackPct', 'fastChoppinessPeriod', 'fastChoppinessMax',
        'fastTradeStartUtc', 'fastTradeEndUtc', 'fastConvictionSizing',
        'fastSlippageBps',
        'fastCooldownSeconds', 'maxPositions', 'maxExposurePct', 'maxSinglePositionPct',
        'fastIntervalSeconds',
      ]),
      ...overrides,
    }
    const base = fastStrategyFromConfig(merged, { sampleIntervalSeconds: intervalSeconds })
    const engine = new BacktestEngine()

    // Windows oldest -> newest.
    const endTimes: number[] = []
    for (let i = windowCount - 1; i >= 0; i--) {
      endTimes.push(Date.now() - i * hours * 3600_000)
    }

    const windows = await Promise.all(
      endTimes.map((endTime, index) => this.loadSamples(symbol, endTime - hours * 3600_000, endTime, hours, index, intervalSeconds))
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
      limitFillSeconds: merged.fastMakerExecution ? merged.fastLimitFillSeconds : 0,
      limitOffsetPct: merged.fastLimitOffsetPct,
      makerFeePct: merged.fastMakerFeePct,
      volTargetPct: merged.fastVolTargetPct,
      volTargetWindowSeconds: merged.fastVolTargetWindowSeconds,
      volTargetMaxMult: merged.fastVolTargetMaxMult,
      slippageBps: merged.fastSlippageBps,
    })

    this.logger.info('')
    this.logger.info(`=== Walk-forward: ${symbol} ${windowCount}×${hours}h (oldest -> newest)${coarse ? ' [1m bars, live config only]' : ''} ===`)

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
      const fmt = (v: number) => (v === Infinity ? 'inf' : v.toFixed(2))

      if (coarse) {
        // No grid: the live config itself is the candidate on every window.
        const oosCoarseResult = engine.run(oosSamples, baseConfig(base))
        const pass = oosCoarseResult.metrics.totalTrades >= minTrades
          && oosCoarseResult.metrics.profitFactor >= minPf
          && oosCoarseResult.strategyReturnPct > 0
        verdicts.push({
          trainIdx: i,
          winner: 'baseline (live config)',
          isTrades: trainResult.metrics.totalTrades,
          isPf: trainResult.metrics.profitFactor,
          isNet: trainResult.strategyReturnPct,
          oosTrades: oosCoarseResult.metrics.totalTrades,
          oosPf: oosCoarseResult.metrics.profitFactor,
          oosNet: oosCoarseResult.strategyReturnPct,
          pass,
        })
        this.logger.info(`w${i} (${trainSamples.length} samples): net ${trainResult.strategyReturnPct >= 0 ? '+' : ''}${trainResult.strategyReturnPct.toFixed(2)}%  ${trainResult.metrics.totalTrades}t PF ${fmt(trainResult.metrics.profitFactor)}  buy&hold ${trainResult.buyHoldReturnPct >= 0 ? '+' : ''}${trainResult.buyHoldReturnPct.toFixed(2)}%`)
        this.logger.info(`  OOS w${i + 1}: ${oosCoarseResult.metrics.totalTrades}t PF ${fmt(oosCoarseResult.metrics.profitFactor)} net ${oosCoarseResult.strategyReturnPct >= 0 ? '+' : ''}${oosCoarseResult.strategyReturnPct.toFixed(2)}%  buy&hold ${oosCoarseResult.buyHoldReturnPct >= 0 ? '+' : ''}${oosCoarseResult.buyHoldReturnPct.toFixed(2)}%  ${pass ? 'PASS' : 'FAIL'} (need PF>=${minPf}, net>0, >=${minTrades}t)`)
        continue
      }

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
    index: number,
    intervalSeconds: number
  ): Promise<BacktestSample[]> {
    const tag = intervalSeconds === 1 ? '1s' : '1m'
    const cacheFile = path.join(CACHE_DIR, `${symbol}_${tag}_${hours}h_wf${index}_v2.json`)
    if (!this.fresh && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        const first = raw[0]?.t
        const last = raw[raw.length - 1]?.t
        // A cached window is only valid if it COVERS the requested span —
        // walk-forward windows are anchored to Date.now(), so yesterday's
        // cache for "window 3" is stale today.
        if (raw.length >= 2 && first !== undefined && last !== undefined &&
            first <= startTime + intervalSeconds * 1000 && last >= endTime - intervalSeconds * 1000) {
          const windowed = raw.filter((s) => s.t >= startTime && s.t < endTime)
          this.logger.info(`Loaded ${windowed.length} cached samples from ${cacheFile}`)
          return windowed
        }
        this.logger.info(`Cache ${cacheFile} no longer covers the requested window — refetching`)
      } catch (err) {
        this.logger.warn(`Cache unreadable, refetching: ${(err as Error).message}`)
      }
    }

    // Partial resume only helps when it fills INSIDE the requested window.
    let pre: BacktestSample[] = []
    try {
      if (fs.existsSync(cacheFile)) {
        const parsedPre = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        pre = parsedPre.filter((s) => s.t >= startTime && s.t < endTime)
        this.logger.info(`Resuming from ${pre.length} in-window samples`)
      }
    } catch { /* ignore unreadable partial */ }
    const cursorStart = pre.length > 0 ? pre[pre.length - 1].t + 1 : startTime
    this.logger.info(`Fetching ${hours}h of ${tag} klines for ${symbol} (window ${index})…`)
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const samples = await fetchBinanceKlines(symbol, cursorStart, endTime, {
      intervalSeconds,
      onProgress: (partial) => {
        try {
          const merged = [...pre, ...partial]
            .sort((a, b) => a.t - b.t)
            .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
            .filter((s) => s.t >= startTime && s.t < endTime)
          fs.writeFileSync(cacheFile, JSON.stringify(merged))
        } catch { /* checkpoint write is best-effort */ }
      },
    })
    const merged = [...pre, ...samples]
      .sort((a, b) => a.t - b.t)
      .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
      .filter((s) => s.t >= startTime && s.t < endTime)
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(merged))
      this.logger.info(`Cached ${merged.length} samples to ${cacheFile}`)
    } catch (err) {
      this.logger.warn(`Failed to cache samples: ${(err as Error).message}`)
    }
    return merged
  }
}
