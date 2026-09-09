// ─── Live 1s-bar recorder ──────────────────────────────────────
//
// Subscribes the Kraken WS public trade channel and aggregates trades into
// 1-second OHLCV bars, persisted to `tick_records`. This is the Kraken-
// native feed for fast-algo backtests: the 10s decision loop needs 1s
// bars, and Kraken's REST OHLC has no sub-minute history — recorded bars
// accumulate the only long-horizon 1s dataset we can get.
//
// Concurrency-safe: bars are written with ON CONFLICT DO NOTHING, so a WS
// reconnect that replays recent trades cannot double-write. The current
// (partial) second is held in memory and only flushed once it is at least
// 60s old — late trades still land in the right bar.

import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import KrakenWS, { KrakenWSTrade } from './KrakenWebSocketService.js'

const FLUSH_INTERVAL_MS = 10_000
const BAR_FINALITY_MS = 60_000
const RETENTION_DAYS = 60

export interface OneSecondBar {
  symbol: string
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Aggregate trades into 1-second OHLCV bars. Pure — testable without a
 * socket or DB. Trade time is epoch seconds; the bar key is the epoch
 * millisecond of the truncated second.
 */
export function aggregateTradesToBars(trades: KrakenWSTrade[], symbol?: string): OneSecondBar[] {
  const bars = new Map<number, OneSecondBar>()

  for (const t of trades) {
    const ts = Math.floor(t.time) * 1000
    let bar = bars.get(ts)
    if (!bar) {
      bar = { symbol: symbol ?? t.symbol, ts, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.volume }
      bars.set(ts, bar)
    } else {
      bar.high = Math.max(bar.high, t.price)
      bar.low = Math.min(bar.low, t.price)
      bar.close = t.price
      bar.volume += t.volume
    }
  }

  return [...bars.values()].sort((a, b) => a.ts - b.ts)
}

class TickRecorderService {
  private buffer = new Map<string, Map<number, OneSecondBar>>()
  private listeners = new Map<string, () => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt: number | null = null
  private lastFlushAt: number | null = null

  constructor(private ws: any = KrakenWS) {}

  public get running(): boolean {
    return this.timer !== null
  }

  public start(symbols: string[]): void {
    if (this.timer) return
    for (const s of symbols) this.addSymbol(s)
    this.timer = setInterval(() => { void this.flush() }, FLUSH_INTERVAL_MS)
    this.startedAt = Date.now()
    logger.info('[TickRecorder] Recording 1s bars for %s (flush every %ds)',
      symbols.join(', '), FLUSH_INTERVAL_MS / 1000)
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const [symbol, unsubscribe] of this.listeners) {
      unsubscribe()
      this.listeners.delete(symbol)
    }
    logger.info('[TickRecorder] Stopped')
  }

  public addSymbol(symbol: string): void {
    const s = symbol.toUpperCase()
    if (this.listeners.has(s)) return
    this.ws.addTradeSymbol(s)
    const unsubscribe = this.ws.onTrade(s, (trade: KrakenWSTrade) => {
      if (trade.symbol !== s) return
      const bucket = Math.floor(trade.time) * 1000
      let perSymbol = this.buffer.get(s)
      if (!perSymbol) {
        perSymbol = new Map()
        this.buffer.set(s, perSymbol)
      }
      const bar = perSymbol.get(bucket)
      if (bar) {
        bar.high = Math.max(bar.high, trade.price)
        bar.low = Math.min(bar.low, trade.price)
        bar.close = trade.price
        bar.volume += trade.volume
      } else {
        perSymbol.set(bucket, {
          symbol: s, ts: bucket, open: trade.price, high: trade.price,
          low: trade.price, close: trade.price, volume: trade.volume,
        })
      }
    })
    this.listeners.set(s, unsubscribe)
  }

  /**
   * Write finalized bars (>= 60s old, so the partial second never lands)
   * to tick_records, dedup via ON CONFLICT. Also prunes rows past
   * RETENTION_DAYS so the table can't grow unbounded.
   */
  public async flush(): Promise<number> {
    const cutoff = Date.now() - BAR_FINALITY_MS
    const bars: OneSecondBar[] = []

    for (const [symbol, perSymbol] of this.buffer) {
      for (const [ts, bar] of perSymbol) {
        if (ts <= cutoff) {
          bars.push(bar)
          perSymbol.delete(ts)
        }
      }
    }

    let written = 0
    if (bars.length > 0) {
      const chunk = 500
      for (let i = 0; i < bars.length; i += chunk) {
        const rows = bars.slice(i, i + chunk)
        await db.table('tick_records')
          .insert(rows)
          .onConflict(['symbol', 'ts'])
          .ignore()
        written += rows.length
      }
      logger.debug('[TickRecorder] Flushed %d bars', bars.length)
    }

    // Bounded retention: drop anything older than the window.
    await db.from('tick_records').where('ts', '<', Date.now() - RETENTION_DAYS * 86_400_000).del()

    this.lastFlushAt = Date.now()
    return written
  }

  public status(): Record<string, any> {
    const buffered = new Map<string, number>()
    for (const [symbol, perSymbol] of this.buffer) {
      buffered.set(symbol, perSymbol.size)
    }
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastFlushAt: this.lastFlushAt,
      symbols: [...this.listeners.keys()],
      bufferedBars: Object.fromEntries(buffered),
    }
  }
}

export default new TickRecorderService()
export { TickRecorderService }