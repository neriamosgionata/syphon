import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import AlgoConfig from '#models/AlgoConfig'
import { fastStrategyFromConfig, FastStrategyConfig } from '#services/FastStrategy'
import { BacktestEngine, BacktestConfig, BacktestResult, BacktestSample } from '#services/BacktestEngine'
import { fetchBinanceKlines1s } from '#services/BinanceKlineService'

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

interface SweepRow {
  label: string
  strategy: FastStrategyConfig
  patch: Partial<BacktestConfig>
}

/**
 * One-at-a-time grid around a baseline config + coherent presets. Shared by
 * backtest:sweep and backtest:walkforward.
 */
export function buildSweepList(base: FastStrategyConfig): SweepRow[] {
  const clone = (): FastStrategyConfig => ({ ...base })
  const rows: SweepRow[] = []
  rows.push({ label: 'baseline (live config)', strategy: clone(), patch: {} })

  const sweep = (label: string, mutate: (c: FastStrategyConfig) => void, patch: Partial<BacktestConfig> = {}) => {
    const c = clone()
    mutate(c)
    rows.push({ label, strategy: c, patch })
  }

  // One-at-a-time around the baseline.
  sweep('momentum window 30s', (c) => { c.momentumSeconds = 30 })
  sweep('momentum window 120s', (c) => { c.momentumSeconds = 120 })
  sweep('threshold 0.10%', (c) => { c.momentumThresholdPct = 0.10 })
  sweep('threshold 0.40%', (c) => { c.momentumThresholdPct = 0.40 })
  sweep('RSI band 30/70', (c) => { c.rsiLow = 30; c.rsiHigh = 70 })
  sweep('SL 0.30%', (c) => { c.stopLossPct = 0.3 })
  sweep('SL 0.80%', (c) => { c.stopLossPct = 0.8 })
  sweep('TP 0.60%', (c) => { c.takeProfitPct = 0.6 })
  sweep('TP 1.50%', (c) => { c.takeProfitPct = 1.5 })
  sweep('TP 2.00%', (c) => { c.takeProfitPct = 2.0 })
  sweep('trailing off', (c) => { c.trailingStopPct = 0; c.trailingActivatePct = 0 })
  sweep('trailing 0.2/0.3', (c) => { c.trailingStopPct = 0.2; c.trailingActivatePct = 0.3 })
  sweep('trailing 0.5/0.8', (c) => { c.trailingStopPct = 0.5; c.trailingActivatePct = 0.8 })
  sweep('max-hold off', (c) => { c.maxHoldSeconds = 0 })
  sweep('max-hold 900s', (c) => { c.maxHoldSeconds = 900 })
  sweep('EMA off', (c) => { c.emaPeriod = 0 })
  sweep('EMA-10', (c) => { c.emaPeriod = 10 })
  sweep('EMA-40', (c) => { c.emaPeriod = 40 })
  sweep('vol mult 4.0', (c) => { c.volatilityMult = 4 })
  sweep('vol scaling off', (c) => { c.volatilityWindowSamples = 0 })
  sweep('cooldown 60s', (c) => { void c }, { cooldownSeconds: 60 })
  sweep('cooldown 300s', (c) => { void c }, { cooldownSeconds: 300 })
  sweep('trend mode on', (c) => { c.trendMode = true; c.emaPeriod = 900; c.trendSlopePct = 0.1; c.trendSlopeWindowSeconds = 1800; c.takeProfitPct = 0; c.trailingStopPct = 2.0; c.trailingActivatePct = 1.5; c.maxHoldSeconds = 0 }, { cooldownSeconds: 1800 })
  sweep('trend + regime gate', (c) => { c.trendMode = true; c.emaPeriod = 900; c.trendSlopePct = 0.1; c.trendSlopeWindowSeconds = 1800; c.takeProfitPct = 0; c.trailingStopPct = 2.0; c.trailingActivatePct = 1.5; c.regimeEmaPeriod = 3600; c.regimeSlopeWindowSeconds = 3600; c.regimeSlopeMinPct = 0.3 }, { cooldownSeconds: 1800 })

  // Presets: coherent multi-param profiles.
  rows.push({
    label: 'PRESET scalp',
    strategy: { ...base, momentumSeconds: 30, momentumThresholdPct: 0.2, stopLossPct: 0.3, takeProfitPct: 0.6, trailingStopPct: 0.2, trailingActivatePct: 0.3, maxHoldSeconds: 600, emaPeriod: 10 },
    patch: { cooldownSeconds: 60 },
  })
  rows.push({
    label: 'PRESET trend',
    strategy: { ...base, momentumSeconds: 120, momentumThresholdPct: 0.4, stopLossPct: 0.8, takeProfitPct: 2.0, trailingStopPct: 0.4, trailingActivatePct: 0.6, maxHoldSeconds: 2700, emaPeriod: 20 },
    patch: {},
  })
  rows.push({
    label: 'PRESET swing',
    strategy: { ...base, momentumSeconds: 120, momentumThresholdPct: 0.3, stopLossPct: 1.2, takeProfitPct: 3.0, trailingStopPct: 0.5, trailingActivatePct: 0.8, maxHoldSeconds: 0, emaPeriod: 40 },
    patch: { cooldownSeconds: 300 },
  })

  return rows
}

interface RankedRow {
  label: string
  trades: number
  winRate: number
  profitFactor: number
  netPct: number
  maxDrawdownPct: number
  avgHold: number | null
  vsBaselinePp: number
}

export default class BacktestSweep extends BaseCommand {
  static commandName = 'backtest:sweep'
  static description = 'Sweep fast-algo strategy parameters and rank the results'
  static options = { startApp: true }

  @flags.string({ description: 'Symbol (default BTC)' })
  declare symbol: string

  @flags.number({ description: 'Hours of 1s data (default 72)' })
  declare hours: number

  @flags.number({ description: 'Minimum trades for a row to rank (default 10)' })
  declare minTrades: number

  @flags.number({ description: 'Top rows to print (default 20)' })
  declare top: number

  @flags.boolean({ description: 'Skip the cache and refetch from Binance' })
  declare fresh: boolean

  @flags.string({ description: 'JSON overrides applied to the baseline before sweeping, e.g. {"fastRsiHigh":1000}' })
  declare config: string

  async run() {
    const symbol = (this.symbol || 'BTC').toUpperCase()
    const hours = Math.min(Math.max(this.hours || 72, 6), 504)
    const minTrades = this.minTrades || 10
    const top = this.top || 20

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
        'fastCooldownSeconds', 'maxPositions', 'maxExposurePct', 'maxSinglePositionPct',
      ]),
      ...overrides,
    }
    const base = fastStrategyFromConfig(merged)
    const samples = await this.loadSamples(symbol, hours, !!this.fresh)

    const baseConfig: BacktestConfig = {
      symbol,
      strategy: base,
      loopIntervalSeconds: cfg.fastIntervalSeconds || 10,
      portfolioUsd: 10_000,
      feePct: 0.0026,
      maxPositions: cfg.maxPositions,
      maxExposurePct: cfg.maxExposurePct,
      maxSinglePositionPct: cfg.maxSinglePositionPct,
      cooldownSeconds: cfg.fastCooldownSeconds,
      correlatedExposurePct: cfg.fastCorrelatedExposurePct,
      riskPerTradePct: cfg.fastRiskPerTradePct,
      maxLossStreak: cfg.fastMaxLossStreak,
      lossStreakPauseSeconds: cfg.fastLossStreakPauseSeconds,
      limitFillSeconds: cfg.fastMakerExecution ? cfg.fastLimitFillSeconds : 0,
      limitOffsetPct: cfg.fastLimitOffsetPct,
      makerFeePct: cfg.fastMakerFeePct,
      volTargetPct: cfg.fastVolTargetPct,
      volTargetWindowSeconds: cfg.fastVolTargetWindowSeconds,
      volTargetMaxMult: cfg.fastVolTargetMaxMult,
    }

    const engine = new BacktestEngine()
    const baseline = engine.run(samples, baseConfig)

    const rows: RankedRow[] = []
    for (const row of buildSweepList(base)) {
      const result = engine.run(samples, { ...baseConfig, strategy: row.strategy, ...row.patch })
      if (result.metrics.totalTrades < minTrades) continue
      rows.push({
        label: row.label,
        trades: result.metrics.totalTrades,
        winRate: result.metrics.winRate,
        profitFactor: result.metrics.profitFactor,
        netPct: result.strategyReturnPct,
        maxDrawdownPct: result.metrics.maxDrawdownPct,
        avgHold: result.metrics.avgHoldingSeconds,
        vsBaselinePp: result.strategyReturnPct - baseline.strategyReturnPct,
      })
    }

    rows.sort((a, b) => {
      const pf = (b.profitFactor === Infinity ? 999 : b.profitFactor) - (a.profitFactor === Infinity ? 999 : a.profitFactor)
      if (pf !== 0) return pf
      if (b.winRate !== a.winRate) return b.winRate - a.winRate
      return a.maxDrawdownPct - b.maxDrawdownPct
    })

    this.printReport(symbol, hours, samples.length, baseline, rows, top)
  }

  private async loadSamples(symbol: string, hours: number, fresh: boolean): Promise<BacktestSample[]> {
    const cacheFile = path.join(CACHE_DIR, `${symbol}_1s_${hours}h_v2.json`)
    if (!fresh && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Loaded ${raw.length} cached samples from ${cacheFile}`)
        return raw
      } catch (err) {
        this.logger.warn(`Cache unreadable, refetching: ${(err as Error).message}`)
      }
    }

    let pre: BacktestSample[] = []
    try {
      if (fs.existsSync(cacheFile)) {
        pre = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Resuming from ${pre.length} partial samples`)
      }
    } catch { /* ignore unreadable partial */ }
    const endTime = Date.now()
    const startTime = endTime - hours * 3600_000
    const cursorStart = pre.length > 0 ? pre[pre.length - 1].t + 1 : startTime
    this.logger.info(`Fetching ${hours}h of 1s klines for ${symbol} from Binance…`)
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const samples = await fetchBinanceKlines1s(symbol, cursorStart, endTime, {
      onProgress: (partial) => {
        try {
          const merged = [...pre, ...partial]
            .sort((a, b) => a.t - b.t)
            .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
          fs.writeFileSync(cacheFile, JSON.stringify(merged))
        } catch { /* checkpoint write is best-effort */ }
      },
    })
    const merged = [...pre, ...samples]
      .sort((a, b) => a.t - b.t)
      .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(merged))
      this.logger.info(`Cached ${merged.length} samples to ${cacheFile}`)
    } catch (err) {
      this.logger.warn(`Failed to cache samples: ${(err as Error).message}`)
    }
    return merged
  }

  private printReport(
    symbol: string,
    hours: number,
    sampleCount: number,
    baseline: BacktestResult,
    rows: RankedRow[],
    top: number
  ): void {
    const bm = baseline.metrics
    this.logger.info('')
    this.logger.info(`=== Sweep: ${symbol} ${hours}h (${sampleCount} samples) ===`)
    this.logger.info(`Baseline: ${bm.totalTrades} trades, WR ${(bm.winRate * 100).toFixed(1)}%, PF ${bm.profitFactor === Infinity ? 'inf' : bm.profitFactor.toFixed(2)}, net ${baseline.strategyReturnPct >= 0 ? '+' : ''}${baseline.strategyReturnPct.toFixed(2)}%, maxDD ${bm.maxDrawdownPct.toFixed(2)}%, avgHold ${bm.avgHoldingSeconds?.toFixed(0) ?? '-'}s`)
    this.logger.info(`Buy&hold: ${baseline.buyHoldReturnPct >= 0 ? '+' : ''}${baseline.buyHoldReturnPct.toFixed(2)}%`)
    this.logger.info('')
    this.logger.info(`${'#'.padStart(3)} ${'Parameter'.padEnd(22)} ${'Trades'.padStart(6)} ${'WR'.padStart(6)} ${'PF'.padStart(6)} ${'Net%'.padStart(8)} ${'maxDD'.padStart(7)} ${'avgHold'.padStart(7)} ${'vsBase'.padStart(8)}`)
    rows.slice(0, top).forEach((r, i) => {
      const net = `${r.netPct >= 0 ? '+' : ''}${r.netPct.toFixed(2)}`.padStart(8)
      const vs = `${r.vsBaselinePp >= 0 ? '+' : ''}${r.vsBaselinePp.toFixed(2)}`.padStart(8)
      this.logger.info(
        `${String(i + 1).padStart(3)} ${r.label.padEnd(22)} ${String(r.trades).padStart(6)} ` +
        `${(r.winRate * 100).toFixed(1).padStart(6)} ${(r.profitFactor === Infinity ? 'inf' : r.profitFactor.toFixed(2)).padStart(6)} ` +
        `${net} ${r.maxDrawdownPct.toFixed(2).padStart(7)} ${(r.avgHold === null ? '-' : r.avgHold.toFixed(0)).padStart(7)} ` +
        `${vs}`
      )
    })
    this.logger.info('')
    this.logger.info('Rows below min-trades threshold were dropped; PF inf = no losing trades.')
  }
}
