import { BaseCommand } from '@adonisjs/core/ace'
import AlgoConfig from '#models/AlgoConfig'
import { BacktestEngine, JEV_REPLAY_STALE_MS } from '#services/BacktestEngine'
import { fastStrategyFromConfig } from '#services/FastStrategy'
import { loadBacktestSamples, loadJevEvents } from '#services/backtest_data'
import { clamp } from '#app/utils/backtest_flags'

// Venue-agnostic backtest runner. Data comes from the live algo broker by
// default (--source auto); --source=kraken|ibkr|recorded overrides.
//   1s kraken → tick_records (live recorder + kraken:backfill)
//   ≥1m kraken → OHLC cache; ibkr → historical-bars cache (1s and up)
// Strategy config comes from the live algo_configs row (same mapping the
// live loop uses) with optional --config JSON overrides on the fast* keys.

const INTERVALS_SECONDS = [1, 60, 300, 900, 1800, 3600, 14400, 86400]

export default class Backtest extends BaseCommand {
  static commandName = 'backtest'
  static description = 'Run a Kraken backtest of the live fast-algo strategy (1s tick_records or OHLC cache)'
  static options = { startApp: true }

static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Ticker symbol (default BTC)' },
    { flagName: 'interval', name: 'interval', type: 'number', description: 'Bar seconds: 1|60|300|900|1800|3600|14400|86400 (default 1)' },
    { flagName: 'hours', name: 'hours', type: 'number', description: 'Backtest window in hours (default 24)' },
    { flagName: 'source', name: 'source', type: 'string', description: 'auto|kraken|ibkr|recorded (default auto = live broker)' },
    { flagName: 'fresh', name: 'fresh', type: 'boolean', description: 'Re-fetch data instead of using the cache' },
    { flagName: 'trades', name: 'trades', type: 'boolean', description: 'List every trade' },
    { flagName: 'config', name: 'config', type: 'string', description: 'JSON overrides on the live algo config (fast* keys)' },
  ]

  async run() {
    const symbol = (this.parsed.flags.symbol || 'BTC').toUpperCase()
    const intervalSeconds = Number(this.parsed.flags.interval ?? 1)
    const hours = Number(this.parsed.flags.hours ?? 24)
    const fresh = Boolean(this.parsed.flags.fresh)
    const listTrades = Boolean(this.parsed.flags.trades)
    const sourceRaw = String(this.parsed.flags.source || 'auto')

    if (!INTERVALS_SECONDS.includes(intervalSeconds)) {
      this.logger.error('Invalid --interval=%d — choose one of %s', intervalSeconds, INTERVALS_SECONDS.join(', '))
      return
    }
    if (!['auto', 'kraken', 'ibkr', 'recorded'].includes(sourceRaw)) {
      this.logger.error('Invalid --source=%s — choose auto|kraken|ibkr|recorded', sourceRaw)
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
    const { samples, label } = await loadBacktestSamples({
      symbol,
      intervalSeconds,
      hours,
      source: sourceRaw as any,
      broker: rawCfg.broker || 'kraken',
      fresh,
    })

    const engine = new BacktestEngine()
    // Recorded Jev scores replay only when the gate is enabled — the
    // engine runs the gate off with a notice when the window is scoreless.
    // Look back one reuse window so a pre-window score governs the first
    // decisions (otherwise it is invisible to the opening ticks).
    const jevEvents = strategy.jevGateEnabled && samples.length > 0
      ? await loadJevEvents(symbol, samples[0].t - JEV_REPLAY_STALE_MS, samples[samples.length - 1].t)
      : undefined
    const result = engine.run(samples, {
      symbol,
      strategy,
      jevEvents,
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
    this.logger.info(`═══ Backtest ${symbol} ${intervalSeconds}s bars / ${hours}h (${label}) ═══`)
    if (result.jevNotice) this.logger.info(`Jev: ${result.jevNotice}`)
    else if (jevEvents && jevEvents.length > 0) {
      this.logger.info(`Jev: replayed ${jevEvents.length} recorded scores (${jevEvents[0].model})`)
    }
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