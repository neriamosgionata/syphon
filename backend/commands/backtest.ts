import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import AlgoConfig from '#models/AlgoConfig'
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

  @flags.number({ description: 'Decision loop interval in seconds (default: live fast_interval_seconds)' })
  declare interval: number

  @flags.number({ description: 'Starting portfolio USD (default 10000)' })
  declare portfolio: number

  @flags.number({ description: 'Taker fee per side as fraction (default 0.0026)' })
  declare fee: number

  @flags.boolean({ description: 'Skip the cache and refetch from Binance' })
  declare fresh: boolean

  async run() {
    const symbol = (this.symbol || 'BTC').toUpperCase()
    const hours = Math.min(Math.max(this.hours || 6, 1), 72)
    const portfolio = this.portfolio || 10000
    const fee = this.fee ?? 0.0026

    const cfg = await AlgoConfig.getConfig()
    const interval = this.interval || cfg.fastIntervalSeconds || 10

    const endTime = Date.now()
    const startTime = endTime - hours * 3600_000
    const samples = await this.loadSamples(symbol, startTime, endTime, hours, !!this.fresh)

    if (samples.length < 2) {
      this.logger.error(`No data fetched for ${symbol}`)
      return
    }

    const result = new BacktestEngine().run(samples, {
      symbol,
      strategy: fastStrategyFromConfig(cfg),
      loopIntervalSeconds: interval,
      portfolioUsd: portfolio,
      feePct: fee,
      maxPositions: cfg.maxPositions,
      maxExposurePct: cfg.maxExposurePct,
      maxSinglePositionPct: cfg.maxSinglePositionPct,
      cooldownSeconds: cfg.fastCooldownSeconds,
    })

    this.printReport(result)
  }

  private async loadSamples(
    symbol: string,
    startTime: number,
    endTime: number,
    hours: number,
    fresh: boolean
  ): Promise<BacktestSample[]> {
    const cacheFile = path.join(CACHE_DIR, `${symbol}_1s_${hours}h.json`)

    if (!fresh && fs.existsSync(cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        this.logger.info(`Loaded ${raw.length} cached samples from ${cacheFile}`)
        return raw
      } catch (err) {
        this.logger.warn(`Cache unreadable, refetching: ${(err as Error).message}`)
      }
    }

    this.logger.info(`Fetching ${hours}h of 1s klines for ${symbol} from Binance…`)
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
