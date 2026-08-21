import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import AlgoConfig from '#models/AlgoConfig'
import { MomentumFeed } from '#services/MomentumFeed'
import { fastStrategyFromConfig } from '#services/FastStrategy'
import { BacktestEngine, BacktestResult, BacktestSample } from '#services/BacktestEngine'
import { fetchBinanceKlines1s } from '#services/BinanceKlineService'

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

export default class Backtest extends BaseCommand {
  static commandName = 'backtest'
  static description = 'Backtest the fast algo strategy on Binance 1s klines'
  static options = { startApp: true }

  @flags.string({ description: 'Symbol (e.g. BTC, BTCUSDT). Default: BTC' })
  declare symbol: string

  @flags.number({ description: 'Hours of 1s data to fetch (default 6, max 72)' })
  declare hours: number

  @flags.number({ description: 'Fetch a window ending N hours ago (walk-forward; default 0 = now)' })
  declare endHoursAgo: number

  @flags.number({ description: 'Decision loop interval in seconds (default: live fast_interval_seconds)' })
  declare interval: number

  @flags.number({ description: 'Starting portfolio USD (default 10000)' })
  declare portfolio: number

  @flags.number({ description: 'Taker fee per side as fraction (default 0.0026)' })
  declare fee: number

  @flags.number({ description: 'Slippage in bps per side (default: config fast_slippage_bps)' })
  declare slippageBps: number

  @flags.string({ description: 'JSON overrides for the strategy config, e.g. {"fastStopLossPct":0.8,"fastEmaPeriod":0}' })
  declare config: string

  @flags.boolean({ description: 'Skip the cache and refetch from Binance' })
  declare fresh: boolean

  @flags.boolean({ description: 'Print momentum/RSI percentiles over the window and exit' })
  declare debug: boolean

  async run() {
    const symbol = (this.symbol || 'BTC').toUpperCase()
    const hours = Math.min(Math.max(this.hours || 6, 1), 504)
    const portfolio = this.portfolio || 10000
    const fee = this.fee ?? 0.0026

    const cfg = await AlgoConfig.getConfig()
    const overrides: Record<string, any> = this.config ? JSON.parse(this.config) : {}
    // Lucid stores model fields in $attributes — `{ ...cfg }` would lose
    // them all. Pick the fields the engine needs explicitly.
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
      ]),
      ...overrides,
    }
    const interval = this.interval || cfg.fastIntervalSeconds || 10

    const endTime = Date.now() - (this.endHoursAgo || 0) * 3600_000
    const startTime = endTime - hours * 3600_000
    const samples = await this.loadSamples(symbol, startTime, endTime, hours, !!this.fresh, this.endHoursAgo || 0)

    if (samples.length < 2) {
      this.logger.error(`No data fetched for ${symbol}`)
      return
    }

    if (this.debug) {
      this.printSignalDebug(samples, [60, 300, 600, 1800])
      return
    }

    const result = new BacktestEngine().run(samples, {
      symbol,
      strategy: fastStrategyFromConfig(merged),
      loopIntervalSeconds: interval,
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

    this.printReport(result)
  }

  private async loadSamples(
    symbol: string,
    startTime: number,
    endTime: number,
    hours: number,
    fresh: boolean,
    endHoursAgo: number
  ): Promise<BacktestSample[]> {
    const windowTag = endHoursAgo > 0 ? `_ago${endHoursAgo}` : ''
    const cacheFile = path.join(CACHE_DIR, `${symbol}_1s_${hours}h${windowTag}_v2.json`)
    if (!fresh && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Loaded ${raw.length} cached samples from ${cacheFile}`)
        return raw
      } catch (err) {
        this.logger.warn(`Cache unreadable, refetching: ${(err as Error).message}`)
      }
    }

    // Resume from a partial cache (progressive checkpoints) if one exists.
    let pre: BacktestSample[] = []
    try {
      if (fs.existsSync(cacheFile)) {
        pre = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Resuming from ${pre.length} partial samples`)
      }
    } catch { /* ignore unreadable partial */ }
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

  private printSignalDebug(samples: BacktestSample[], windows: number[]): void {
    const feed = new MomentumFeed()
    const startTime = samples[0].t
    const endTime = samples[samples.length - 1].t
    const step = 300_000 // sample every 5 minutes
    const percentiles = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]

    const collect = (windowSeconds: number): { pcts: Record<number, number>; count: number } => {
      const vals: number[] = []
      feed.clearAll()
      for (const s of samples) {
        feed.push(this.symbol, s.p, s.t)
        if (s.t - startTime >= windowSeconds * 1000 && (s.t - startTime) % step < 1000) {
          const m = feed.momentumPct(this.symbol, windowSeconds, s.t)
          if (m !== null) vals.push(m)
        }
      }
      vals.sort((a, b) => a - b)
      const pcts: Record<number, number> = {}
      for (const p of percentiles) {
        const idx = Math.min(vals.length - 1, Math.floor(p * vals.length))
        pcts[p] = vals.length > 0 ? vals[idx] : NaN
      }
      return { pcts, count: vals.length }
    }

    this.logger.info(`--- Signal debug: ${this.symbol} ${((endTime - startTime) / 3600_000).toFixed(1)}h, ${samples.length} samples ---`)
    this.logger.info(`Buy&hold: ${(((samples[samples.length - 1].p - samples[0].p) / samples[0].p) * 100).toFixed(2)}%`)
    for (const w of windows) {
      const { pcts, count } = collect(w)
      const line = Object.entries(pcts)
        .map(([p, v]) => `p${(Number(p) * 100).toFixed(0)}=${v.toFixed(3)}%`)
        .join('  ')
      this.logger.info(`momentum ${w}s (n=${count}): ${line}`)
    }
  }

  private printReport(result: BacktestResult): void {
    const m = result.metrics
    const spanHours = ((result.endTime - result.startTime) / 3600_000).toFixed(1)
    const loopSeconds = result.equityCurve.length > 1
      ? Math.round((result.equityCurve[1].t - result.equityCurve[0].t) / 1000)
      : 0

    this.logger.info('')
    this.logger.info(`=== Backtest: ${result.symbol} (${result.samples} samples over ${spanHours}h, ${loopSeconds}s loop) ===`)
    this.logger.info(`Start: $${result.startUsd.toFixed(2)}  End: $${result.endUsd.toFixed(2)}  Return: ${result.strategyReturnPct >= 0 ? '+' : ''}${result.strategyReturnPct.toFixed(2)}%  (buy&hold: ${result.buyHoldReturnPct >= 0 ? '+' : ''}${result.buyHoldReturnPct.toFixed(2)}%)`)
    this.logger.info('')
    this.logger.info(`Trades: ${m.totalTrades}  Wins: ${m.winCount}  Losses: ${m.lossCount}  Win rate: ${(m.winRate * 100).toFixed(1)}%`)
    this.logger.info(`Net PnL: $${m.totalPnl.toFixed(2)}  Avg trade: ${m.avgPnlPct >= 0 ? '+' : ''}${m.avgPnlPct.toFixed(3)}%  PF: ${m.profitFactor === Infinity ? 'inf' : m.profitFactor.toFixed(2)}`)
    this.logger.info(`Largest win: $${m.largestWin.toFixed(2)}  Largest loss: $${m.largestLoss.toFixed(2)}  Max drawdown: ${m.maxDrawdownPct.toFixed(2)}%`)
    this.logger.info(`Avg holding: ${m.avgHoldingSeconds === null ? '-' : `${m.avgHoldingSeconds.toFixed(0)}s`}`)
    this.logger.info('')

    if (result.trades.length === 0) {
      this.logger.info('No trades — strategy gates never passed.')
      return
    }

    this.logger.info('Recent trades:')
    for (const t of result.trades.slice(-10)) {
      const entry = new Date(t.entryTime).toISOString().slice(11, 19)
      const exit = t.exitTime ? new Date(t.exitTime).toISOString().slice(11, 19) : '-'
      this.logger.info(`  ${entry} BUY  ${t.quantity.toFixed(4)} @ ${t.entryPrice.toFixed(2)}  -> ${exit} @ ${t.exitPrice?.toFixed(2) ?? '-'}  ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%)  ${t.exitReason ?? '-'}`)
    }
  }
}
