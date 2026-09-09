// ─── Yahoo Finance daily bars (quant snapshot backfill) ───────
//
// The chart API (query1.finance.yahoo.com) serves clean JSON OHLCV for
// years of daily history without auth — the only stock daily-bar source
// that works from this network right now (Stooq = JS PoW challenge,
// Google Finance = chart data removed from the page, TWS = needs a live
// Gateway). Used by quant:snapshots to backfill the Meili snapshots the
// validation harness needs.

export interface DailyBar {
  date: string // YYYY-MM-DD
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart'

export class YahooDataService {
  /**
   * Daily OHLCV bars for a symbol, oldest first. `days` caps history.
   * Throws on transport/parse failure (the caller decides fallbacks).
   */
  public async getDailyBars(symbol: string, days: number = 1825): Promise<DailyBar[]> {
    const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=${Math.min(days, 3650)}d`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Syphon/1.0)' },
    })
    if (!res.ok) throw new Error(`Yahoo chart ${res.status} for ${symbol}`)
    const json: any = await res.json().catch(() => null)
    const result = json?.chart?.result?.[0]
    const timestamps: number[] = result?.timestamp || []
    const quote = result?.indicators?.quote?.[0] || {}
    if (timestamps.length === 0) throw new Error(`Yahoo chart: no data for ${symbol}`)

    const cutoff = Date.now() - days * 86_400_000
    const bars: DailyBar[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i] * 1000
      if (ts < cutoff) continue
      const open = quote.open?.[i]
      const high = quote.high?.[i]
      const low = quote.low?.[i]
      const close = quote.close?.[i]
      if (!Number.isFinite(close) || close === null) continue
      bars.push({
        date: new Date(ts).toISOString().slice(0, 10),
        open: Number(open ?? close),
        high: Number(high ?? close),
        low: Number(low ?? close),
        close: Number(close),
        volume: Number(quote.volume?.[i] ?? 0),
      })
    }
    return bars
  }
}

export default new YahooDataService()