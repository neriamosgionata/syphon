// ─── Kraken public market-data access ──────────────────────────
//
// OHLC candles + trade history via the public REST API (no keys needed).
// This is the Kraken-native backtest data source — the Binance path is
// gone (Italy venue rule) and Kraken has no 1s OHLC history, so:
//   - minute+ bars:   /0/public/OHLC, paged with `since`, cached to JSON
//   - 1s bars:        /0/public/Trades reconstructed into 1s OHLCV bars
//                     (bounded practical depth: ~1-3 days of BTC at the
//                     public tier's 1 req/s)
//   - live 1s bars:   KrakenWebSocketService trade stream → TickRecorder
//
// Rate discipline: the public tier allows ~1 req/s. Every public call is
// throttled with a minimum spacing; rate-limit errors retry with backoff.

import KrakenService from './KrakenService.js'

const KRAKEN_BASE = 'https://api.kraken.com'

const MIN_REQUEST_SPACING_MS = 1100
const RATE_LIMIT_RETRIES = 3

export interface KrakenCandle {
  /** Epoch seconds. */
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface KrakenTrade {
  price: number
  volume: number
  /** Epoch seconds. */
  time: number
  side: 'buy' | 'sell'
  ordertype: 'market' | 'limit'
}

export interface TradesPage {
  trades: KrakenTrade[]
  /** Trade id to pass as `since` for the older page. */
  lastTradeId: string | null
}

class KrakenDataService {
  private lastRequestAt = 0

  constructor(
    private pairFn: (symbol: string, currency?: string) => string = (s, c = 'USD') =>
      KrakenService.buildPair(s, c)
  ) {}

  /**
   * Kraken returns the pair under its normalized name (XXBTZUSD for
   * XBTUSD), so the rows are found by scanning for the array value —
   * the response holds exactly one rows array plus the `last` marker.
   */
  private resultRows(result: any): any[][] {
    if (!result || typeof result !== 'object') return []
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) return value as any[][]
    }
    return []
  }

  /** Minimum spacing between public requests (1 req/s tier). */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastRequestAt = Date.now()
  }

  private async publicRequest(path: string, params: Record<string, any> = {}): Promise<any> {
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      await this.throttle()
      const qs = Object.keys(params).length
        ? '?' + new URLSearchParams(params as Record<string, string>).toString()
        : ''
      const res = await fetch(`${KRAKEN_BASE}${path}${qs}`)
      const json: any = await res.json().catch(() => null)
      if (json?.error && json.error.length > 0) {
        const msg = json.error.join('; ')
        if (/rate limit|too many requests|EAPI:Rate/i.test(msg) && attempt < RATE_LIMIT_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
          continue
        }
        throw new Error(msg)
      }
      return json?.result
    }
    throw new Error(`Kraken public request failed after ${RATE_LIMIT_RETRIES} retries: ${path}`)
  }

  /**
   * One OHLC page: the last 720 candles for the interval, or older history
   * when `since` (epoch seconds) is given.
   */
  public async getOHLC(
    symbol: string,
    intervalMinutes: number,
    since?: number
  ): Promise<{ candles: KrakenCandle[]; lastTime: number | null }> {
    const pair = this.pairFn(symbol)
    const params: Record<string, string> = {
      pair,
      interval: String(intervalMinutes),
    }
    if (since) params.since = String(since)

    const result = await this.publicRequest('/0/public/OHLC', params)
    const rows = this.resultRows(result)
    const candles: KrakenCandle[] = rows.map((r) => ({
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[6]),
    }))
    const lastTime = result?.last ? Number(result.last) : candles.length ? candles[candles.length - 1].time : null
    return { candles, lastTime }
  }

  /**
   * Walk OHLC pages back until the oldest candle is at or before
   * `targetStartMs` (or `maxPages` reached). Returns candles ascending.
   */
  public async walkOHLC(
    symbol: string,
    intervalMinutes: number,
    targetStartMs: number,
    maxPages = 400
  ): Promise<KrakenCandle[]> {
    const collected: KrakenCandle[] = []
    let since: number | undefined
    let guard = 0

    while (guard++ < maxPages) {
      const { candles, lastTime } = await this.getOHLC(symbol, intervalMinutes, since)
      if (candles.length === 0) break
      collected.unshift(...candles)
      const oldest = candles[0].time
      if (oldest * 1000 <= targetStartMs || !lastTime) break
      since = oldest
    }
    return collected
  }

  /**
   * One trades page: the last 1000 trades for the pair, or older trades
   * when `sinceTradeId` (the previous page's `last`) is given.
   */
  public async getTrades(symbol: string, sinceTradeId?: string): Promise<TradesPage> {
    const pair = this.pairFn(symbol)
    const params: Record<string, string> = { pair }
    if (sinceTradeId) params.since = sinceTradeId

    const result = await this.publicRequest('/0/public/Trades', params)
    const rows = this.resultRows(result)
    const trades: KrakenTrade[] = rows.map((r) => ({
      price: Number(r[0]),
      volume: Number(r[1]),
      time: Number(r[2]),
      side: r[3] === 'b' ? 'buy' : 'sell',
      ordertype: r[4] === 'l' ? 'limit' : 'market',
    }))
    return { trades, lastTradeId: result?.last ? String(result.last) : null }
  }

  /**
   * Walk trades back until the oldest trade is at or before `targetStartMs`
   * (or `maxPages` reached). Returns trades ascending (oldest first).
   */
  public async walkTrades(symbol: string, targetStartMs: number, maxPages = 5000): Promise<KrakenTrade[]> {
    const collected: KrakenTrade[] = []
    let since: string | undefined
    let guard = 0

    while (guard++ < maxPages) {
      const { trades, lastTradeId } = await this.getTrades(symbol, since)
      if (trades.length === 0 || !lastTradeId) break
      collected.unshift(...trades)
      const oldest = trades[0].time
      if (oldest * 1000 <= targetStartMs) break
      since = lastTradeId
    }
    return collected
  }
}

export default new KrakenDataService()
export { KrakenDataService }