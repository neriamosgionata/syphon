import { BaseCommand } from '@adonisjs/core/ace'
import * as fs from 'node:fs'
import * as path from 'node:path'
import db from '@adonisjs/lucid/services/db'
import AlgoConfig from '#models/AlgoConfig'
import { BacktestEngine, BacktestSample } from '#services/BacktestEngine'
import { fastStrategyFromConfig } from '#services/FastStrategy'
import KrakenDataService from '#services/KrakenDataService'
import { clamp } from '#app/utils/backtest_flags'

// Kraken-only backtest runner. Data sources:
//   --interval=1s  -> tick_records (live recorder + kraken:backfill)
//   --interval>=1m -> Kraken OHLC cache (auto-fetched when missing)
// Strategy config comes from the live algo_configs row (same mapping the
// live loop uses) with optional --config JSON overrides on the fast* keys.

const CACHE_DIR = path.join(import.meta.dirname, '..', 'backtests', 'cache', 'kraken')
const INTERVALS_SECONDS = [1, 60, 300, 900, 1800, 3600, 14400, 86400]

async function loadSamples(
  symbol: string,
  intervalSeconds: number,
  hours: number,
  freshCache: boolean
): Promise<{ samples: BacktestSample[]; fromCache: boolean }> {
  if (intervalSeconds === 1) {
    const start = Date.now() - hours * 3600_000
    const rows = await db.from('tick_records')
      .where('symbol', symbol)
      .where('ts', '>=', start)
      .orderBy('ts', 'asc')
    const samples = rows.map((r) => ({
      t: Number(r.ts),
      p: Number(r.close),
      h: Number(r.high),
      l: Number(r.low),
      v: Number(r.volume),
    }))
    return { samples, fromCache: false }
  }

  const intervalMin = intervalSeconds / 60
  const file = path.join(CACHE_DIR, `${symbol}_${intervalMin}m_${hours}h.json`)
  if (!freshCache && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { samples: cached.samples, fromCache: true }
  }

  const targetStart = Date.now() - hours * 3600_000
  const candles = await KrakenDataService.walkOHLC(symbol, intervalMin, targetStart)
  if (candles.length === 0) throw new Error(`No OHLC data for ${symbol} ${intervalMin}m`)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const samples = candles
    .filter((c) => c.time * 1000 >= targetStart)
    .map((c) => ({ t: c.time * 1000, p: c.close, h: c.high, l: c.low, v: c.volume }))
  fs.writeFileSync(file, JSON.stringify({ symbol, intervalMin, fetchedAt: new Date().toISOString(), samples }))
  return { samples, fromCache: true }
}

export default class Backtest extends BaseCommand {
  static commandName = 'backtest'
  static description = 'Run a Kraken backtest of the live fast-algo strategy (1s tick_records or OHLC cache)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Ticker symbol (default BTC)' },
    { flagName: 'interval', name: 'interval', type: 'number', description: 'Bar seconds: 1|60|300|900|1800|3600|14400|86400 (default 1)' },
    { flagName: 'hours', name: 'hours', type: 'number', description: 'Backtest window in hours (default 24)' },
    { flagName: 'fresh', name: 'fresh', type: 'boolean', description: 'Re-fetch OHLC instead of using the cache' },
    { flagName: 'trades', name: 'trades', type: 'boolean', description: 'List every trade' },
    { flagName: 'config', name: 'config', type: 'string', description: 'JSON overrides on the live algo config (fast* keys)' },
  ]

  async run() {
    const symbol = (this.parsed.flags.symbol || 'BTC').toUpperCase()
    const intervalSeconds = Number(this.parsed.flags.interval ?? 1)
    const hours = Number(this.parsed.flags.hours ?? 24)
    const fresh = Boolean(this.parsed.flags.fresh)
    const listTrades = Boolean(this.parsed.flags.trades)

    if (!INTERVALS_SECONDS.includes(intervalSeconds)) {
      this.logger.error('Invalid --interval=%d — choose one of %s', intervalSeconds, INTERVALS_SECONDS.join(', '))
      return
    }

    const config = await AlgoConfig.getConfig()
    const rawCfg: Record<string, any> = { ...config.$attributes }
    const overridesRaw = this.parsed.flags.config
    if (overridesRaw) {
      try {
        const parsed = JSON.parse(String(overridesRaw))
        Object.assign(rawCfg, parsed)
      } catch {
        this.logger.error('--config must be valid JSON')
        return
      }
    }

    const strategy = fastStrategyFromConfig(rawCfg, { sampleIntervalSeconds: intervalSeconds })
    const { samples, fromCache } = await loadSamples(symbol, intervalSeconds, hours, fresh)

    const engine = new BacktestEngine()
    const result = engine.run(samples, {
      symbol,
      strategy,
      loopIntervalSeconds: clamp(rawCfg.fastIntervalSeconds || 10, 5, 300),
      portfolioUsd: 10_000,
      feePct: Number(rawCfg.fastMakerFeePct ?? 0.0026),
      maxPositions: clamp(rawCfg.maxPositions || 1, 1, 50),
      maxExposurePct: clamp(rawCfg.maxExposurePct || 0.8, 0.1, 1),
      maxSinglePositionPct: clamp(rawCfg.maxSinglePositionPct || 0.15, 0.01, 0.5),
      cooldownSeconds: clamp(rawCfg.fastCooldownSeconds || 180, 10, 3600),
      correlatedExposurePct: rawCfg.fastCorrelatedExposurePct || 0,
      riskPerTradePct: rawCfg.fastRiskPerTradePct || 0,
      maxLossStreak: rawCfg.fastMaxLossStreak || 0,
      lossStreakPauseSeconds: rawCfg.fastLossStreakPauseSeconds || 0,
      slippageBps: rawCfg.fastSlippageBps || 0,
    })

    const m = result.metrics
    this.logger.info('')
    this.logger.info(`═══ Backtest ${symbol} ${intervalSeconds}s bars / ${hours}h (${fromCache ? 'OHLC cache' : 'tick_records'}) ═══`)
    this.logger.info(`Window: ${new Date(result.startTime).toISOString()} → ${new Date(result.endTime).toISOString()} (${result.samples} samples)`)
    this.logger.info(`Strategy: ${result.strategyReturnPct.toFixed(2)}%   Buy&hold: ${result.buyHoldReturnPct.toFixed(2)}%   $${result.startUsd} → $${Math.round(result.endUsd)}`)
    this.logger.info(`Trades: ${m.totalTrades}   Win rate: ${(m.winRate * 100).toFixed(0)}%   PF: ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}   Max DD: ${m.maxDrawdownPct.toFixed(2)}%   Avg hold: ${m.avgHoldingSeconds === null ? '—' : `${Math.round(m.avgHoldingSeconds / 60)}m`}`)
    this.logger.info(`Total PnL: $${m.totalPnl.toFixed(2)}   Largest win: $${m.largestWin.toFixed(2)}   Largest loss: $${m.largestLoss.toFixed(2)}`)

    if (listTrades) {
      for (const t of result.trades) {
        this.logger.info(`  ${t.side} ${t.symbol} qty=${t.quantity} @${t.entryPrice.toFixed(2)} → ${t.exitPrice === null ? '—' : t.exitPrice.toFixed(2)} ${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(2)}%) [${t.exitReason}]`)
      }
    }
  }
}