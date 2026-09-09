// ─── Backtest data loader (venue-agnostic) ────────────────────
//
// One entry point for backtest/sweep sample loading:
//   source 'recorded' → tick_records (live recorder / kraken:backfill)
//   source 'kraken'   → 1s: tick_records; ≥1m: Kraken OHLC cache
//   source 'ibkr'     → IBKR historical bars cache (1s and up)
//   source 'auto'     → from the live algo_configs broker
// All ≥1m sources cache to backtests/cache/{kraken|ibkr}/… and
// auto-fetch when missing; `fresh` re-fetches.

import * as fs from 'node:fs'
import * as path from 'node:path'
import db from '@adonisjs/lucid/services/db'
import KrakenDataService from '#services/KrakenDataService'
import IBKRDataService from '#services/IBKRDataService'
import type { BacktestSample } from '#services/BacktestEngine'

export type BacktestSource = 'auto' | 'kraken' | 'ibkr' | 'recorded'

const CACHE_ROOT = path.join(import.meta.dirname, '..', '..', 'backtests', 'cache')

export function cacheFile(source: 'kraken' | 'ibkr', symbol: string, intervalMinutes: number, hours: number): string {
  return path.join(CACHE_ROOT, source, `${symbol}_${intervalMinutes}m_${hours}h.json`)
}

async function fromTickRecords(symbol: string, hours: number): Promise<BacktestSample[]> {
  const start = Date.now() - hours * 3600_000
  const rows = await db.from('tick_records')
    .where('symbol', symbol)
    .where('ts', '>=', start)
    .orderBy('ts', 'asc')
  return rows.map((r) => ({
    t: Number(r.ts),
    p: Number(r.close),
    h: Number(r.high),
    l: Number(r.low),
    v: Number(r.volume),
  }))
}

async function fromKrakenOHLC(symbol: string, intervalMinutes: number, hours: number, fresh: boolean): Promise<BacktestSample[]> {
  const file = cacheFile('kraken', symbol, intervalMinutes, hours)
  if (!fresh && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).samples
  }
  const targetStart = Date.now() - hours * 3600_000
  const candles = await KrakenDataService.walkOHLC(symbol, intervalMinutes, targetStart)
  if (candles.length === 0) throw new Error(`No Kraken OHLC data for ${symbol} ${intervalMinutes}m`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const samples = candles
    .filter((c) => c.time * 1000 >= targetStart)
    .map((c) => ({ t: c.time * 1000, p: c.close, h: c.high, l: c.low, v: c.volume }))
  fs.writeFileSync(file, JSON.stringify({ symbol, intervalMinutes, fetchedAt: new Date().toISOString(), samples }))
  return samples
}

async function fromIBKR(symbol: string, intervalMinutes: number, hours: number, fresh: boolean): Promise<BacktestSample[]> {
  const file = cacheFile('ibkr', symbol, intervalMinutes, hours)
  if (!fresh && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).samples
  }
  const targetStart = Date.now() - hours * 3600_000
  const candles = await IBKRDataService.walkOHLC(symbol, intervalMinutes, targetStart)
  if (candles.length === 0) throw new Error(`No IBKR historical data for ${symbol} ${intervalMinutes}m`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const samples = candles
    .filter((c) => c.time * 1000 >= targetStart)
    .map((c) => ({ t: c.time * 1000, p: c.close, h: c.high, l: c.low, v: c.volume }))
  fs.writeFileSync(file, JSON.stringify({ symbol, intervalMinutes, fetchedAt: new Date().toISOString(), samples }))
  return samples
}

export async function loadBacktestSamples(opts: {
  symbol: string
  intervalSeconds: number
  hours: number
  source: BacktestSource
  broker: string
  fresh?: boolean
}): Promise<{ samples: BacktestSample[]; label: string }> {
  const intervalMin = opts.intervalSeconds / 60
  const source: BacktestSource =
    opts.source === 'auto'
      ? opts.broker === 'ibkr' ? 'ibkr' : 'kraken'
      : opts.source

  if (source === 'recorded' || (source === 'kraken' && opts.intervalSeconds === 1)) {
    return { samples: await fromTickRecords(opts.symbol, opts.hours), label: 'tick_records' }
  }
  if (source === 'ibkr') {
    return { samples: await fromIBKR(opts.symbol, intervalMin, opts.hours, !!opts.fresh), label: 'IBKR cache' }
  }
  return { samples: await fromKrakenOHLC(opts.symbol, intervalMin, opts.hours, !!opts.fresh), label: 'Kraken OHLC cache' }
}