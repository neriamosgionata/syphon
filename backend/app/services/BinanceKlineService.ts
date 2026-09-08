// ─── Binance kline fetcher for backtesting ────────────────────
//
// Public REST, no API key. 1-second spot klines give the sub-minute
// resolution the fast strategy needs (10-60s momentum windows); 1m klines
// provide the multi-year history the strategy can only be certified on.
//
// Rate limits: /api/v3/klines with limit=1000 costs 20 weight; the public
// tier allows ~6000 weight/min, so ~150ms between pages is safe. Default
// 6h of 1s data = ~22 pages; a 3-year 1m crawl ≈ 1600 pages.

import logger from '@adonisjs/core/services/logger'
import type { BacktestSample } from '#services/BacktestEngine'

const BINANCE_REST = 'https://api.binance.com'
const MAX_KLINES_PER_REQUEST = 1000
const MAX_PAGES_1S = 2000 // ~23 days of 1s data
const MAX_PAGES_COARSE = 100_000 // multi-year 1m crawls (~1600 pages/year)
const PAGE_DELAY_MS = 150

const INTERVALS_MS: Record<string, number> = {
  '1s': 1000,
  '1m': 60_000,
  '1d': 86_400_000,
}

function intervalKeyFor(intervalSeconds: number): string {
  if (intervalSeconds >= 86_400) return '1d'
  if (intervalSeconds >= 60) return '1m'
  return '1s'
}

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

export interface BinanceFetchOptions {
  onProgress?: (samples: BacktestSample[]) => void
  /** Bar interval: '1s' (default) or '1m'. */
  intervalSeconds?: number
}

/**
 * Fetch kline closes in [startTime, endTime) at `intervalSeconds`
 * (1 = 1s bars, 60 = 1m bars). Returns samples with intrabar h/l/v for
 * stop/target fills and the volume gate.
 */
export async function fetchBinanceKlines(
  symbol: string,
  startTime: number,
  endTime: number,
  opts?: BinanceFetchOptions
): Promise<BacktestSample[]> {
  const intervalSeconds = Math.min(Math.max(opts?.intervalSeconds || 1, 1), 3600 * 24)
  const intervalKey = intervalKeyFor(intervalSeconds)
  const intervalLabel = intervalSeconds >= 86_400 ? '1d' : intervalSeconds >= 60 ? `${intervalSeconds / 60}m` : `${intervalSeconds}s`
  const intervalMs = INTERVALS_MS[intervalKey]
  const pair = toBinancePair(symbol)
  const samples: BacktestSample[] = []
  const seen = new Set<number>()
  const maxPages = intervalKey === '1s' ? MAX_PAGES_1S : MAX_PAGES_COARSE

  let cursor = startTime
  let pages = 0
  while (cursor < endTime && pages < maxPages) {
    const url = `${BINANCE_REST}/api/v3/klines?symbol=${pair}&interval=${intervalKey}` +
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
    cursor = next + intervalMs
    pages++
    // Checkpoint ~every 25 pages so an interrupted fetch can resume.
    if (pages % 25 === 0) opts?.onProgress?.(samples)
    if (pages < maxPages) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
  }
  opts?.onProgress?.(samples)

  samples.sort((a, b) => a.t - b.t)
  logger.info('[Binance] Fetched %d %s samples for %s (%d pages)', samples.length, intervalLabel, pair, pages)
  return samples
}

/**
 * Fetch 1s closes in [startTime, endTime) — close-only series for the
 * intraminute feed (backward-compatible wrapper).
 */
export async function fetchBinanceKlines1s(
  symbol: string,
  startTime: number,
  endTime: number,
  opts?: { onProgress?: (samples: BacktestSample[]) => void }
): Promise<BacktestSample[]> {
  return fetchBinanceKlines(symbol, startTime, endTime, opts)
}
