// ─── IBKR historical market data (backtest provider) ──────────
//
// MarketDataProvider implementation over reqHistoricalData — the stock
// side of the backtest infra. Minute+ bars map straight to Kraken's OHLC
// intervals; 1s bars (which Kraken cannot serve) come from '1 secs'
// historical bars, chunked per hour to stay inside IBKR's per-request
// limits (~3600 bars).
//
// Walk pattern mirrors KrakenDataService.walkOHLC: page back from `now`
// with endDateTime = earliest bar time until the target start is covered.
// Cache files land in backtests/cache/ibkr/ — same shape as the kraken
// cache, so backtest/sweep treat both sources identically.

import Ticker from '#models/Ticker'
import IBKRService from './IBKRService.js'
import { contractForTicker } from './ibkr_contracts.js'
import type { MarketDataProvider } from './market_types.js'

export interface HistoricalBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** intervalMinutes → IBKR bar size + safe per-request duration (~≤3600 bars). */
const BAR_SIZE_MAP: Record<number, { barSize: string; duration: string }> = {
  1: { barSize: '1 secs', duration: '3600 S' },
  60: { barSize: '1 min', duration: '1 D' },
  300: { barSize: '5 mins', duration: '5 D' },
  900: { barSize: '15 mins', duration: '7 D' },
  1800: { barSize: '30 mins', duration: '14 D' },
  3600: { barSize: '1 hour', duration: '30 D' },
  14400: { barSize: '4 hours', duration: '120 D' },
  86400: { barSize: '1 day', duration: '1 Y' },
}

export class IBKRDataService implements MarketDataProvider {
  constructor(
    private ibkr: any = IBKRService,
    private tickerModel: typeof Ticker = Ticker
  ) {}

  private contractCache = new Map<string, any>()

  private async contractFor(symbol: string): Promise<any | null> {
    if (this.contractCache.has(symbol)) return this.contractCache.get(symbol) ?? null
    try {
      const ticker = await this.tickerModel.findBy('symbol', symbol)
      if (!ticker || !ticker.secType) {
        this.contractCache.set(symbol, null)
        return null
      }
      const contract = contractForTicker(ticker)
      this.contractCache.set(symbol, contract)
      return contract
    } catch {
      return null
    }
  }

  /** One historical window for a symbol at an IBKR bar size. */
  public async getOHLC(
    symbol: string,
    intervalMinutes: number,
    since?: number
  ): Promise<{ candles: HistoricalBar[]; lastTime: number | null }> {
    const contract = await this.contractFor(symbol)
    if (!contract) throw new Error(`No ticker row with contract metadata for ${symbol}`)

    const cfg = BAR_SIZE_MAP[intervalMinutes]
    if (!cfg) throw new Error(`Unsupported interval ${intervalMinutes}m for IBKR`)

    const endDateTime = since
      ? new Date(since * 1000).toISOString().slice(0, 19).replace('T', ' ')
      : ''
    const bars = await this.ibkr.getHistoricalBars({
      contract,
      barSize: cfg.barSize,
      duration: cfg.duration,
      endDateTime,
    })
    const candles = bars.map((b: HistoricalBar) => ({
      time: b.time,
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }))
    return {
      candles,
      lastTime: candles.length > 0 ? candles[candles.length - 1].time : null,
    }
  }

  /** Page back until the oldest candle is at or before `targetStartMs`. */
  public async walkOHLC(
    symbol: string,
    intervalMinutes: number,
    targetStartMs: number,
    maxPages = 400
  ): Promise<HistoricalBar[]> {
    const collected: HistoricalBar[] = []
    let since: number | undefined
    let guard = 0

    while (guard++ < maxPages) {
      const { candles } = await this.getOHLC(symbol, intervalMinutes, since)
      if (candles.length === 0) break
      collected.unshift(...candles)
      const oldest = candles[0].time
      if (oldest * 1000 <= targetStartMs) break
      since = oldest
    }
    return collected
  }
}

export default new IBKRDataService()