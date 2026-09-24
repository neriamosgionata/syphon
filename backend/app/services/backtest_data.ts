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
import type { BacktestSample, JevReplayEvent } from '#services/BacktestEngine'

export type BacktestSource = 'auto' | 'kraken' | 'ibkr' | 'recorded' | 'bar_records'

const CACHE_ROOT = path.join(import.meta.dirname, '..', '..', 'backtests', 'cache')

export function cacheFile(source: 'kraken' | 'ibkr', symbol: string, intervalMinutes: number, hours: number): string {
  return path.join(CACHE_ROOT, source, `${symbol}_${intervalMinutes}m_${hours}h.json`)
}

function rowToSample(row: any): BacktestSample {
  return {
    t: Number(row.ts),
    p: row.close,
    h: row.high,
    l: row.low,
    v: row.volume,
  }
}

function candleToSample(candle: { time: number; close: number; high: number; low: number; volume: number }): BacktestSample {
  return { t: candle.time * 1000, p: candle.close, h: candle.high, l: candle.low, v: candle.volume }
}

async function fromTickRecords(symbol: string, hours: number): Promise<BacktestSample[]> {
  const start = Date.now() - hours * 3600_000
  const rows = await db.from('tick_records')
    .where('symbol', symbol)
    .where('ts', '>=', start)
    .orderBy('ts', 'asc')
  return rows.map(rowToSample)
}

/**
 * Recorded multi-interval bars (bar_records, intervals >= 60s). Exact
 * interval match, ascending, same sample shape as the cache sources — the
 * trend evaluator and backtests read one code path.
 */
async function fromBarRecords(symbol: string, intervalSeconds: number, hours: number): Promise<BacktestSample[]> {
  const start = Date.now() - hours * 3600_000
  const rows = await db.from('bar_records')
    .where('symbol', symbol)
    .where('interval_seconds', intervalSeconds)
    .where('ts', '>=', start)
    .orderBy('ts', 'asc')
  return rows.map(rowToSample)
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
    .map(candleToSample)
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
    .map(candleToSample)
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
}): Promise<{ samples: BacktestSample[]; label: string }> {  const intervalMin = opts.intervalSeconds / 60
  const source: BacktestSource =
    opts.source === 'auto'
      ? opts.broker === 'ibkr' ? 'ibkr' : 'kraken'
      : opts.source

  if (source === 'recorded' || (source === 'kraken' && opts.intervalSeconds === 1)) {
    return { samples: await fromTickRecords(opts.symbol, opts.hours), label: 'tick_records' }
  }
  if (source === 'bar_records') {
    return {
      samples: await fromBarRecords(opts.symbol, opts.intervalSeconds, opts.hours),
      label: `bar_records ${opts.symbol} ${opts.intervalSeconds}s/${opts.hours}h`,
    }
  }
  if (source === 'ibkr') {
    return { samples: await fromIBKR(opts.symbol, intervalMin, opts.hours, !!opts.fresh), label: 'IBKR cache' }
  }
  return { samples: await fromKrakenOHLC(opts.symbol, intervalMin, opts.hours, !!opts.fresh), label: 'Kraken OHLC cache' }
}

/**
 * Recorded Jev scores for a symbol over [startMs, endMs], ascending.
 * Fixture rows never certify — they are excluded so offline development
 * data cannot leak into a promotion window.
 */
export async function loadJevEvents(symbol: string, startMs: number, endMs: number): Promise<JevReplayEvent[]> {
  const rows = await db.from('ml_scores')
    .where('symbol', symbol)
    .where('decided_at', '>=', startMs)
    .where('decided_at', '<=', endMs)
    .where('fixture', false)
    .orderBy('decided_at', 'asc')
  return rows.map((row: any) => ({
    t: Number(row.decided_at),
    pUp: row.p_up === null || row.p_up === undefined ? null : Number(row.p_up),
    pDown: row.p_down === null || row.p_down === undefined ? null : Number(row.p_down),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    model: String(row.model),
    questionHash: String(row.question_hash ?? ''),
    promptVersion: String(row.prompt_version ?? 'v1'),
    stale: !!row.stale,
    enforced: !!row.enforced,
  }))
}

/**
 * Retention enforcement for the append-only score store (security
 * remediation): delete rows older than the cutoff, returning the count.
 * Scheduling lives with the rollout/ops units; the certifier refuses
 * windows that outlive retention instead of silently running scoreless.
 */
export async function pruneMlScores(cutoffMs: number): Promise<number> {
  return db.from('ml_scores').where('decided_at', '<', cutoffMs).del()
}