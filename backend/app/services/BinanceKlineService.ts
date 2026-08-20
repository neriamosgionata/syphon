// ─── Binance 1s kline fetcher for backtesting ─────────────────
//
// Public REST, no API key. 1-second spot klines give the sub-minute
// resolution the fast strategy needs (10-60s momentum windows).
//
// Rate limits: /api/v3/klines with limit=1000 costs 20 weight; the public
// tier allows ~6000 weight/min, so ~150ms between pages is safe. Default
// 6h of 1s data = ~22 pages.

import logger from '@adonisjs/core/services/logger'
import type { BacktestSample } from '#services/BacktestEngine'

const BINANCE_REST = 'https://api.binance.com'
const MAX_KLINES_PER_REQUEST = 1000
const MAX_PAGES = 600 // ~6.9 days of 1s data
const PAGE_DELAY_MS = 150

interface BinanceKline {
  openTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

export function toBinancePair(symbol: string): string {
  const up = symbol.toUpperCase().trim()
  if (up.endsWith('USDT')) return up
  return `${up}USDT`
}

export function parseBinanceKline(raw: any[]): BinanceKline {
  return {
    openTime: Number(raw[0]),
    open: String(raw[1]),
    high: String(raw[2]),
    low: String(raw[3]),
    close: String(raw[4]),
    volume: String(raw[5]),
  }
}

/**
 * Fetch 1s closes in [startTime, endTime). Returns close prices only —
 * the feed/strategy consume a price series, not bars.
 */
export async function fetchBinanceKlines1s(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<BacktestSample[]> {
  const pair = toBinancePair(symbol)
  const samples: BacktestSample[] = []
  const seen = new Set<number>()

  let cursor = startTime
  let pages = 0
  while (cursor < endTime && pages < MAX_PAGES) {
    const url = `${BINANCE_REST}/api/v3/klines?symbol=${pair}&interval=1s` +
      `&startTime=${cursor}&endTime=${endTime}&limit=${MAX_KLINES_PER_REQUEST}`

    let json: any[]
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const body = await res.text()
        if (res.status === 429 || res.status === 418) {
          // Rate-limited: back off and retry once.
          logger.warn('[Binance] Rate limited, backing off 1s')
          await new Promise((r) => setTimeout(r, 1000))
          continue
        }
        throw new Error(`Binance klines HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      json = await res.json()
    } catch (err) {
      throw new Error(`Failed to fetch ${pair} klines: ${(err as Error).message}`)
    }

    if (!Array.isArray(json) || json.length === 0) break

    for (const raw of json) {
      const k = parseBinanceKline(raw)
      const close = Number(k.close)
      if (Number.isFinite(close) && close > 0 && !seen.has(k.openTime)) {
        seen.add(k.openTime)
        samples.push({ t: k.openTime, p: close })
      }
    }

    const next = json[json.length - 1][0] as number
    if (next <= cursor) break // no progress → guard against infinite loop
    cursor = next + 1000
    pages++
    if (pages < MAX_PAGES) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
  }

  samples.sort((a, b) => a.t - b.t)
  logger.info('[Binance] Fetched %d 1s samples for %s (%d pages)', samples.length, pair, pages)
  return samples
}
