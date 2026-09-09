import { BaseCommand } from '@adonisjs/core/ace'
import * as fs from 'node:fs'
import * as path from 'node:path'
import Ticker from '#models/Ticker'
import MeilisearchService from '#services/MeilisearchService'
import YahooDataService from '#services/YahooDataService'
import GoogleFinanceService from '#services/GoogleFinanceService'
import KrakenDataService from '#services/KrakenDataService'

// Backfill daily price snapshots for the quant engine. The cron path only
// accumulates ~1 bar/day, so the validation harness (needs 81+ bars per
// ticker) is unusable until this runs. Data sources, in order: Yahoo
// chart API (works keyless), Google Finance page fallback; --kraken reads
// crypto daily bars from the Kraken 1d OHLC cache (or fetches fresh).
// Idempotent — existing snapshot dates are skipped.

const CACHE_DIR = path.join(import.meta.dirname, '..', 'backtests', 'cache')

export default class QuantSnapshots extends BaseCommand {
  static commandName = 'quant:snapshots'
  static description = 'Backfill daily snapshots (Yahoo chart API / Kraken OHLC) for active tickers'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbols', name: 'symbols', type: 'string', description: 'Comma-separated symbols (default: all active tickers)' },
    { flagName: 'days', name: 'days', type: 'number', description: 'History in days (default 1825)' },
    { flagName: 'delay', name: 'delay', type: 'number', description: 'Delay between tickers in ms (default 500)' },
    { flagName: 'kraken', name: 'kraken', type: 'boolean', description: 'Use Kraken 1d OHLC for the given symbols (crypto)' },
  ]

  /** Load the carry-era 1d cache file ({SYM}_1d_{days}d.json) if present. */
  private cachedDailyBars(symbol: string, days: number): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> | null {
    try {
      const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(`${symbol}_1d_`) && f.endsWith('.json'))
      if (files.length === 0) return null
      files.sort((a, b) => b.length - a.length || b.localeCompare(a))
      const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, files[0]), 'utf8'))
      // Cache files come in two shapes: a bare sample array (carry-era) or
      // { samples: [...] } (kraken:fetch).
      const samples = Array.isArray(parsed) ? parsed : parsed.samples
      if (!Array.isArray(samples) || samples.length === 0) return null
      const cutoff = Date.now() - days * 86_400_000
      return samples
        .filter((s: any) => s.t >= cutoff)
        .map((s: any) => ({
          date: new Date(s.t).toISOString().slice(0, 10),
          open: Number(s.o ?? s.p), high: Number(s.h ?? s.p),
          low: Number(s.l ?? s.p), close: Number(s.p), volume: Number(s.v ?? 0),
        }))
    } catch {
      return null
    }
  }

  async run() {
    const symbolsRaw = String(this.parsed.flags.symbols || '').toUpperCase()
    const days = Number(this.parsed.flags.days ?? 1825)
    const delay = Number(this.parsed.flags.delay ?? 500)
    const kraken = Boolean(this.parsed.flags.kraken)

    let tickers = symbolsRaw
      ? await Ticker.query().whereIn('symbol', symbolsRaw.split(',').map((s) => s.trim()))
      : await Ticker.query().where('is_active', true).orderBy('symbol')

    // Crypto symbols may not have ticker rows yet (the Kraken engine creates
    // them at order time) — create them so the quant path can score them.
    if (kraken && symbolsRaw) {
      for (const symbol of symbolsRaw.split(',').map((s) => s.trim())) {
        if (!tickers.some((t) => t.symbol === symbol)) {
          const created = await Ticker.create({
            symbol,
            name: symbol,
            secType: 'crypto',
            exchange: 'KRAKEN',
            currency: 'USD',
            isActive: true,
          })
          tickers = [...tickers, created]
        }
      }
    }

    if (tickers.length === 0) {
      this.logger.error('No tickers found')
      return
    }

    this.logger.info(`═══ Snapshot backfill: ${tickers.length} tickers, ${days}d, source: ${kraken ? 'kraken' : 'yahoo'} ═══`)
    let total = 0
    let failed = 0

    for (const ticker of tickers) {
      try {
        let bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = []
        if (kraken) {
          const cacheHit = await this.cachedDailyBars(ticker.symbol, days)
          if (cacheHit) {
            bars = cacheHit
          } else {
            const candles = await KrakenDataService.walkOHLC(
              ticker.symbol, 1440, Date.now() - days * 86_400_000
            )
            bars = candles
              .filter((c) => c.time * 1000 >= Date.now() - days * 86_400_000)
              .map((c) => ({
                date: new Date(c.time * 1000).toISOString().slice(0, 10),
                open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
              }))
          }
        } else {
          bars = await YahooDataService.getDailyBars(ticker.symbol, days)
          if (bars.length === 0) {
            // Fallback: Google Finance page scrape (chart data removed from
            // the page for most symbols, but kept for completeness).
            const history = await GoogleFinanceService.fetchHistorical(
              ticker.symbol,
              new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
              undefined,
              ticker.exchange || undefined
            )
            bars = history.map((b) => ({
              date: b.date.toISOString().slice(0, 10),
              open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
            }))
          }
        }

        let created = 0
        // Batch idempotency: load the ticker's existing dates ONCE instead
        // of one Meili query per date (1250+ dates × 122 tickers otherwise).
        const existingDates = new Set(
          (await MeilisearchService.getSnapshotsForTicker(ticker.id)).map((s: any) => s.date)
        )
        const fresh = bars.filter((bar) => !existingDates.has(bar.date))
        if (fresh.length > 0) {
          await MeilisearchService.saveSnapshots(
            fresh.map((bar) => ({
              tickerId: ticker.id,
              tickerSymbol: ticker.symbol,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              changePercent: null,
              date: bar.date,
            }))
          )
          created = fresh.length
        }
        total += created
        this.logger.info(`  ${ticker.symbol.padEnd(6)} +${created} snapshots (${bars.length} bars)`)
      } catch (err) {
        failed++
        this.logger.error(`  ${ticker.symbol} FAILED: ${(err as Error).message}`)
      }
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }

    this.logger.info('')
    this.logger.info(`Done: ${total} new snapshots, ${failed} tickers failed`)
  }
}