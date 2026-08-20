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
const MAX_PAGES = 2000 // ~23 days of 1s data
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
  endTime: number,
  opts?: { onProgress?: (samples: BacktestSample[]) => void }
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
    let rateLimitRetries = 0
    try {
      let res: Response
      // 429/418: back off and retry (bounded — Binance can throttle for a
      // while; looping forever on a persistent 429 would hang the command).
      while (true) {
        res = await fetch(url)
        if (res.status === 429 || res.status === 418) {
          rateLimitRetries++
          if (rateLimitRetries > 5) {
            throw new Error(`Binance rate limit persisted after ${rateLimitRetries} retries (HTTP ${res.status})`)
          }
          const waitMs = 1000 * Math.pow(2, rateLimitRetries)
          logger.warn('[Binance] Rate limited (HTTP %d), backing off %dms', res.status, waitMs)
          await new Promise((r) => setTimeout(r, waitMs))
          continue
        }
        break
      }
      if (!res.ok) {
        const body = await res.text()
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
      const high = Number(k.high)
      const low = Number(k.low)
      const volume = Number(k.volume)
      if (Number.isFinite(close) && close > 0 && !seen.has(k.openTime)) {
        seen.add(k.openTime)
        samples.push({
          t: k.openTime,
          p: close,
          h: Number.isFinite(high) ? high : close,
          l: Number.isFinite(low) ? low : close,
          v: Number.isFinite(volume) && volume > 0 ? volume : undefined,
        })
      }
    }

    const next = json[json.length - 1][0] as number
    if (next <= cursor) break // no progress → guard against infinite loop
    cursor = next + 1000
    pages++
    // Checkpoint ~every 25 pages so an interrupted fetch can resume.
    if (pages % 25 === 0) opts?.onProgress?.(samples)
    if (pages < MAX_PAGES) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
  }
  opts?.onProgress?.(samples)

  samples.sort((a, b) => a.t - b.t)
  logger.info('[Binance] Fetched %d 1s samples for %s (%d pages)', samples.length, pair, pages)
  return samples
}
