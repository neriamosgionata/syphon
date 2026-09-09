import { BaseCommand } from '@adonisjs/core/ace'
import * as fs from 'node:fs'
import * as path from 'node:path'
import KrakenDataService from '#services/KrakenDataService'

// Minute+ OHLC cache for backtests. Kraken has no sub-minute OHLC history,
// so 1s data comes from tick_records (kraken:backfill / the live recorder).
const CACHE_DIR = path.join(import.meta.dirname, '..', 'backtests', 'cache', 'kraken')

const INTERVALS_MIN = [1, 5, 15, 30, 60, 240, 1440]

export default class KrakenFetch extends BaseCommand {
  static commandName = 'kraken:fetch'
  static description = 'Fetch Kraken OHLC candles into the backtest cache (minute+ intervals)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Ticker symbol (default BTC)' },
    { flagName: 'interval', name: 'interval', type: 'number', description: 'Candle interval in minutes: 1|5|15|30|60|240|1440 (default 1)' },
    { flagName: 'hours', name: 'hours', type: 'number', description: 'History to fetch in hours (default 24)' },
    { flagName: 'fresh', name: 'fresh', type: 'boolean', description: 'Ignore the cache and re-fetch' },
  ]

  async run() {
    const symbol = (this.parsed.flags.symbol || 'BTC').toUpperCase()
    const intervalMin = Number(this.parsed.flags.interval || 1)
    const hours = Number(this.parsed.flags.hours || 24)
    const fresh = Boolean(this.parsed.flags.fresh)

    if (!INTERVALS_MIN.includes(intervalMin)) {
      this.logger.error(`Invalid interval ${intervalMin} — choose one of ${INTERVALS_MIN.join(', ')}`)
      return
    }

    const file = path.join(CACHE_DIR, `${symbol}_${intervalMin}m_${hours}h.json`)
    if (!fresh && fs.existsSync(file)) {
      this.logger.info(`[KrakenFetch] Cache hit: ${file}`)
      return
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const targetStart = Date.now() - hours * 3600_000
    this.logger.info(`[KrakenFetch] ${symbol} ${intervalMin}m bars, walking back to ${new Date(targetStart).toISOString()}`)

    const candles = await KrakenDataService.walkOHLC(symbol, intervalMin, targetStart)
    if (candles.length === 0) {
      this.logger.error('[KrakenFetch] No candles fetched')
      return
    }

    const samples = candles
      .filter((c) => c.time * 1000 >= targetStart)
      .map((c) => ({ t: c.time * 1000, p: c.close, h: c.high, l: c.low, v: c.volume }))

    fs.writeFileSync(file, JSON.stringify({ symbol, intervalMin, fetchedAt: new Date().toISOString(), samples }))
    this.logger.info(`[KrakenFetch] ${samples.length} samples -> ${file} (${((samples[samples.length - 1].t - samples[0].t) / 3600_000).toFixed(1)}h)`)
  }
}