import { BaseCommand } from '@adonisjs/core/ace'
import db from '@adonisjs/lucid/services/db'
import KrakenDataService from '#services/KrakenDataService'
import { aggregateTradesToBars } from '#services/TickRecorderService'

export default class KrakenBackfill extends BaseCommand {
  static commandName = 'kraken:backfill'
  static description = 'Backfill 1s OHLCV bars from the Kraken REST Trades endpoint into tick_records'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Ticker symbol (default BTC)' },
    { flagName: 'hours', name: 'hours', type: 'number', description: 'Hours to walk back (default 6)' },
  ]

  async run() {
    const symbol = (this.parsed.flags.symbol || 'BTC').toUpperCase()
    const hours = Number(this.parsed.flags.hours || 6)
    const startMs = Date.now() - hours * 3600_000

    this.logger.info(`[KrakenBackfill] ${symbol}: walking trades back ${hours}h`)
    const trades = await KrakenDataService.walkTrades(symbol, startMs)
    if (trades.length === 0) {
      this.logger.warn('[KrakenBackfill] No trades fetched (rate limited or empty window)')
      return
    }

    const bars = aggregateTradesToBars(trades, symbol)
    const coverageFrom = bars[0]?.ts ?? 0
    const coverageTo = bars[bars.length - 1]?.ts ?? 0
    const coverageH = coverageTo > 0 ? (coverageTo - coverageFrom) / 3600_000 : 0

    let written = 0
    for (let i = 0; i < bars.length; i += 500) {
      const chunk = bars.slice(i, i + 500)
      const res = await db.table('tick_records').insert(chunk).onConflict(['symbol', 'ts']).ignore()
      written += Number((res as any)?.length ?? res ?? 0)
    }

    this.logger.info(`[KrakenBackfill] ${trades.length} trades -> ${bars.length} bars (${coverageH.toFixed(1)}h coverage ${new Date(coverageFrom).toISOString()}..${new Date(coverageTo).toISOString()}), ${written} new rows`)
  }
}