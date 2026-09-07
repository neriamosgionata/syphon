import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import AlgoConfig from '#models/AlgoConfig'
import { fastStrategyFromConfig } from '#services/FastStrategy'
import { BacktestEngine, BacktestConfig, BacktestResult, BacktestSample } from '#services/BacktestEngine'
import { fetchBinanceKlines } from '#services/BinanceKlineService'

// Multi-year certification harness. 1s history is ~21 days deep and one
// regime sample — no walk-forward can certify a config on it. Binance 1m
// klines reach back years, giving trend/regime/vol windows thousands of
// trades across many regimes.
//
// Runs the LIVE config (optionally JSON-overridden) three ways:
//   1. full contiguous span (compounding equity, honest strategy return)
//   2. consecutive non-overlapping windows (regime breakdown + positive-
//      window rate vs buy&hold — the certification statistic)
//   3. per full year, same lens
// No IS parameter selection: the config under test is the one that would
// actually trade. (Sweeps on 1s data select; this certifies.)

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

const DAY_MS = 24 * 3600_000

export default class BacktestLongterm extends BaseCommand {
  static commandName = 'backtest:longterm'
  static description = 'Multi-year certification of the live config on Binance 1m klines'
  static options = { startApp: true }

  @flags.string({ description: 'Symbol (e.g. BTC, BTCUSDT). Default: BTC' })
  declare symbol: string

  @flags.number({ description: 'Days of history to fetch (default 1095 = 3y)' })
  declare days: number

  @flags.number({ description: 'Breakdown window length in days (default 30)' })
  declare windowDays: number

  @flags.string({ description: 'JSON overrides for the strategy config, e.g. {"fastStopLossPct":0.8}' })
  declare config: string

  @flags.boolean({ description: 'Skip the cache and refetch from Binance' })
  declare fresh: boolean

  @flags.number({ description: 'Taker fee per side as fraction (default 0.0026)' })
  declare fee: number

  @flags.number({ description: 'Slippage in bps per side (default: config fast_slippage_bps)' })
  declare slippageBps: number

  @flags.number({ description: 'Starting portfolio USD (default 10000)' })
  declare portfolio: number

  async run() {
    const symbol = (this.symbol || 'BTC').toUpperCase()
    const days = Math.min(Math.max(this.days || 1095, 30), 3650)
    const windowDays = Math.min(Math.max(this.windowDays || 30, 7), Math.floor(days / 2))
    const portfolio = this.portfolio || 10000
    const fee = this.fee ?? 0.0026

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
    const strategy = fastStrategyFromConfig(merged, { sampleIntervalSeconds: 60 })
    const engine = new BacktestEngine()

    const baseConfig = (): BacktestConfig => ({
      symbol,
      strategy,
      loopIntervalSeconds: merged.fastIntervalSeconds || 10, // floored to 60s by the engine on 1m bars
      portfolioUsd: portfolio,
      feePct: fee,
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
      slippageBps: this.slippageBps ?? merged.fastSlippageBps,
    })

    const endTime = Date.now()
    const startTime = endTime - days * DAY_MS
    const samples = await this.loadSamples(symbol, startTime, endTime, days)
    if (samples.length < 2) {
      this.logger.error(`No data fetched for ${symbol}`)
      return
    }

    const first = samples[0].t
    const last = samples[samples.length - 1].t
    const actualDays = (last - first) / DAY_MS
    this.logger.info('')
    this.logger.info(`=== Long-term certification: ${symbol} 1m bars, ${actualDays.toFixed(1)} days ` +
      `(${new Date(first).toISOString().slice(0, 10)} → ${new Date(last).toISOString().slice(0, 10)}), ${samples.length} samples ===`)

    const fmt = (v: number) => (v === Infinity ? 'inf' : v.toFixed(2))
    const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

    // 1. Full contiguous span — compounding equity.
    const full = engine.run(samples, baseConfig())
    const annFactor = 365 / actualDays
    const annStrategy = ((full.endUsd / full.startUsd) ** annFactor - 1) * 100
    const bhFirst = samples[0].p
    const bhLast = samples[samples.length - 1].p
    const annBh = bhFirst > 0 ? ((bhLast / bhFirst) ** annFactor - 1) * 100 : 0
    this.logger.info('')
    this.logger.info(`FULL SPAN: ${pct(full.strategyReturnPct)} net  ${full.metrics.totalTrades}t  WR ${(full.metrics.winRate * 100).toFixed(1)}%  PF ${fmt(full.metrics.profitFactor)}  ` +
      `maxDD ${full.metrics.maxDrawdownPct.toFixed(2)}%  buy&hold ${pct(full.buyHoldReturnPct)}  ` +
      `(annualized: ${pct(annStrategy)} strategy vs ${pct(annBh)} bh)`)

    // 2. Consecutive non-overlapping windows — regime lens.
    const windowMs = windowDays * DAY_MS
    const windows: Array<{ start: number; end: number; samples: BacktestSample[] }> = []
    let cursor = first
    while (cursor < last) {
      const wEnd = Math.min(cursor + windowMs, last + 60_000)
      const slice = samples.filter((s) => s.t >= cursor && s.t < wEnd)
      if (slice.length >= 2) windows.push({ start: cursor, end: wEnd, samples: slice })
      cursor = wEnd
    }

    this.logger.info('')
    this.logger.info(`Per-window breakdown (${windowDays}d windows, oldest → newest):`)
    this.logger.info('  window           days  trades  WR%    PF     net     buy&hold  vs-bh(pp)')
    let winNet = 0
    let winVsBh = 0
    let totalStrategy = 0
    let totalBh = 0
    let totalTrades = 0
    for (const w of windows) {
      const r = engine.run(w.samples, baseConfig())
      const spanDays = (w.end - w.start) / DAY_MS
      const vsBh = r.strategyReturnPct - r.buyHoldReturnPct
      if (r.strategyReturnPct > 0) winNet++
      if (r.buyHoldReturnPct > 0 ? r.strategyReturnPct > r.buyHoldReturnPct : r.strategyReturnPct > 0) winVsBh++
      totalStrategy += r.strategyReturnPct
      totalBh += r.buyHoldReturnPct
      totalTrades += r.metrics.totalTrades
      const label = new Date(w.start).toISOString().slice(0, 10)
      this.logger.info(`  ${label}  ${spanDays.toFixed(0).padStart(4)}d  ${String(r.metrics.totalTrades).padStart(5)}  ${(r.metrics.winRate * 100).toFixed(0).padStart(4)}  ${fmt(r.metrics.profitFactor).padStart(5)}  ${pct(r.strategyReturnPct).padStart(8)}  ${pct(r.buyHoldReturnPct).padStart(9)}  ${vsBh >= 0 ? '+' : ''}${vsBh.toFixed(2)}`)
    }
    this.logger.info('')
    this.logger.info(`CERTIFICATION: ${winNet}/${windows.length} windows net-positive; ${winVsBh}/${windows.length} beat buy&hold; ` +
      `Σ net ${pct(totalStrategy)} vs Σ buy&hold ${pct(totalBh)} over ${totalTrades} trades`)
    this.logger.info('(Mean return per window and per-trade edge only become meaningful once windows clear ~30+ trades each.)')

    if (full.metrics.totalTrades === 0) {
      this.logger.info('No trades — strategy gates never passed on this data.')
    }
  }

  private async loadSamples(symbol: string, startTime: number, endTime: number, days: number): Promise<BacktestSample[]> {
    const cacheFile = path.join(CACHE_DIR, `${symbol}_1m_${days}d.json`)
    if (!this.fresh && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        const first = raw[0]?.t
        const last = raw[raw.length - 1]?.t
        if (raw.length >= 2 && first !== undefined && last !== undefined &&
            first <= startTime + 60_000 && last >= endTime - 120_000) {
          this.logger.info(`Loaded ${raw.length} cached 1m samples from ${cacheFile}`)
          return raw
        }
        this.logger.info(`Cache ${cacheFile} stale (${raw.length} samples) — refetching missing span`)
      } catch (err) {
        this.logger.warn(`Cache unreadable, refetching: ${(err as Error).message}`)
      }
    }

    // Resume from the tail of any partial cache (multi-year crawls are long).
    let pre: BacktestSample[] = []
    try {
      if (fs.existsSync(cacheFile)) {
        pre = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Resuming from ${pre.length} partial samples`)
      }
    } catch { /* ignore unreadable partial */ }
    const cursorStart = pre.length > 0 ? pre[pre.length - 1].t + 1 : startTime

    this.logger.info(`Fetching ${days}d of 1m klines for ${symbol} from Binance (checkpointed every ~25 pages)…`)
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const samples = await fetchBinanceKlines(symbol, cursorStart, endTime, {
      intervalSeconds: 60,
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
}
