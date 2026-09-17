// ─── Multi-interval bar recorder ──────────────────────────────
//
// Kraken's public OHLC endpoint only serves the last 720 candles per
// interval, so a multi-month 5m history can only exist by recording
// forward. This service fetches closed candles for the frozen trend
// basket, upserts them into bar_records (conflict-ignore: overlapping
// fetch windows and re-runs are idempotent), prunes beyond retention, and
// exposes a coverage/health signal the evaluator and status surfaces read.
//
// The in-progress bar is never stored; a fetch failure leaves stored rows
// untouched and is reported as unhealthy coverage rather than silence.

import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import KrakenDataService, { KrakenCandle } from './KrakenDataService.js'

export const DEFAULT_BAR_SYMBOLS = ['BTC', 'ETH', 'SOL']
export const PRIMARY_INTERVAL_MINUTES = 5
export const OPPORTUNISTIC_INTERVALS_MINUTES = [60, 1440]

/** Kraken's OHLC page depth — also the widest gap that can still be refetched. */
export const KRAKEN_WINDOW_BARS = 720
export const RECORD_INTERVAL_MS = 5 * 60 * 1000
export const RETENTION_DAYS = 400

/** Fetch 1h/1d bars on every Nth pass (every 60 min of 5m passes). */
const OPPORTUNISTIC_EVERY_PASSES = 12

/** Retention prune cadence: every Nth pass (keeps the range delete off most ticks). */
const PRUNE_EVERY_PASSES = 12

interface BarDataProvider {
  getOHLC(
    symbol: string,
    intervalMinutes: number,
    since?: number
  ): Promise<{ candles: KrakenCandle[]; lastTime: number | null }>
}

export interface BarGap {
  from: number
  to: number
  missingBars: number
  unrecoverable: boolean
}

export interface BarCoverage {
  symbol: string
  intervalSeconds: number
  oldest: number | null
  newest: number | null
  bars: number
  gaps: BarGap[]
  unrecoverableGaps: number
  staleMs: number | null
  lastError: string | null
  healthy: boolean
}

export interface BarRow {
  symbol: string
  interval_seconds: number
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Shift a millisecond timestamp forward past the oldest bar Kraken can serve. */
function fetchBoundary(newestStored: number | null, intervalMs: number, now: number): number {
  return Math.max(newestStored ?? 0, now - KRAKEN_WINDOW_BARS * intervalMs)
}

class BarRecorderService {
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt: number | null = null
  private lastRunAt: number | null = null
  private passCount = 0
  private inFlight = false
  private lastErrors = new Map<string, string>()

  constructor(
    private data: BarDataProvider = KrakenDataService,
    private now: () => number = Date.now,
    private symbols: string[] = DEFAULT_BAR_SYMBOLS
  ) {}

  public get running(): boolean {
    return this.timer !== null
  }

  public start(symbols?: string[]): void {
    if (this.timer) return
    if (symbols && symbols.length > 0) this.symbols = symbols
    void this.recordAll()
    this.timer = setInterval(() => {
      void this.recordAll()
    }, RECORD_INTERVAL_MS)
    this.startedAt = this.now()
    logger.info('[BarRecorder] Recording closed bars for %s', this.symbols.join(', '))
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    logger.info('[BarRecorder] Stopped')
  }

  /** One recording pass. Never overlaps; per symbol+interval failures are recorded, not thrown. */
  public async recordAll(): Promise<Record<string, any>> {
    if (this.inFlight) return { skipped: 'in-flight' }
    this.inFlight = true
    this.passCount++
    const results: Record<string, any> = {}

    try {
      const intervals = [...new Set(
        [PRIMARY_INTERVAL_MINUTES, ...(this.passCount % OPPORTUNISTIC_EVERY_PASSES === 1 ? OPPORTUNISTIC_INTERVALS_MINUTES : [])]
      )]

      for (const symbol of this.symbols) {
        for (const intervalMinutes of intervals) {
          const key = `${symbol.toUpperCase()}:${intervalMinutes * 60}`
          try {
            const written = await this.recordSymbol(symbol, intervalMinutes)
            results[key] = { ok: true, written }
            this.lastErrors.delete(key)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            results[key] = { ok: false, error: message }
            this.lastErrors.set(key, message)
            logger.warn(`[BarRecorder] ${key} fetch failed: ${message}`)
          }
        }
      }

      await this.pruneIfDue()
      this.lastRunAt = this.now()
      return results
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Fetch and store the closed bars of one symbol+interval. Fetches only
   * beyond the newest stored bar (or the 720-bar boundary), so repeated
   * passes stay cheap and never re-fetch history.
   */
  public async recordSymbol(symbol: string, intervalMinutes: number): Promise<number> {
    const upper = symbol.toUpperCase()
    const intervalSeconds = intervalMinutes * 60
    const intervalMs = intervalSeconds * 1000
    const now = this.now()

    const newestStored = await this.newestTs(upper, intervalSeconds)

    // No closed bar can exist before two intervals past the newest stored one.
    if (newestStored !== null && now < newestStored + 2 * intervalMs) return 0

    const boundary = fetchBoundary(newestStored, intervalMs, now)
    const sinceSeconds = boundary > 0 ? Math.floor(boundary / 1000) : undefined

    const { candles } = await this.data.getOHLC(upper, intervalMinutes, sinceSeconds)

    const rows: BarRow[] = []
    for (const candle of candles) {
      const ts = candle.time * 1000
      if (ts + intervalMs > now) continue // in-progress bar
      if (newestStored !== null && ts <= newestStored) continue // already stored
      rows.push({
        symbol: upper,
        interval_seconds: intervalSeconds,
        ts,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })
    }

    if (rows.length === 0) return 0

    const chunk = 500
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk)
      await db.table('bar_records').insert(slice).onConflict(['symbol', 'interval_seconds', 'ts']).ignore()
    }
    return rows.length
  }

  /** Retention prune. 400 days default — never shortens the evaluation window. */
  public async prune(): Promise<number> {
    const cutoff = this.now() - RETENTION_DAYS * 86_400_000
    const deleted = await db.from('bar_records').where('ts', '<', cutoff).del()
    return Number(deleted) || 0
  }

  /** Prune on a slow cadence: the delete is a range scan with little to do. */
  private async pruneIfDue(): Promise<void> {
    if (this.passCount % PRUNE_EVERY_PASSES === 1) await this.prune()
  }

  private async newestTs(symbol: string, intervalSeconds: number): Promise<number | null> {
    const row = await db
      .from('bar_records')
      .where('symbol', symbol)
      .where('interval_seconds', intervalSeconds)
      .orderBy('ts', 'desc')
      .select('ts')
      .first()
    return row?.ts === null || row?.ts === undefined ? null : Number(row.ts)
  }

  /** Oldest/newest/gaps/health for one series, computed without row materialization. */
  public async coverage(symbol: string, intervalSeconds: number): Promise<BarCoverage> {
    const upper = symbol.toUpperCase()
    const intervalMs = intervalSeconds * 1000

    const totals = await this.scalarRow(
      'SELECT MIN(ts) AS oldest, MAX(ts) AS newest, COUNT(*) AS bars FROM bar_records WHERE symbol = ? AND interval_seconds = ?',
      [upper, intervalSeconds]
    )
    const oldest = totals?.oldest === null || totals?.oldest === undefined ? null : Number(totals.oldest)
    const newest = totals?.newest === null || totals?.newest === undefined ? null : Number(totals.newest)
    const bars = Number(totals?.bars ?? 0)

    // Only gap boundaries come back from SQL, never the whole series.
    const gapRows = await this.rows(
      `SELECT ts, prev_ts FROM (
         SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev_ts
         FROM bar_records WHERE symbol = ? AND interval_seconds = ?
       ) WHERE prev_ts IS NOT NULL AND ts - prev_ts > ?`,
      [upper, intervalSeconds, intervalMs]
    )

    const gaps: BarGap[] = gapRows.map((row) => {
      const ts = Number(row.ts)
      const previous = Number(row.prev_ts)
      return {
        from: previous + intervalMs,
        to: ts,
        missingBars: (ts - previous) / intervalMs - 1,
        unrecoverable: ts - previous > KRAKEN_WINDOW_BARS * intervalMs,
      }
    })

    const unrecoverableGaps = gaps.filter((gap) => gap.unrecoverable).length
    const lastError = this.lastErrors.get(`${upper}:${intervalSeconds}`) ?? null
    const staleMs = newest === null ? null : this.now() - newest - intervalMs

    return {
      symbol: upper,
      intervalSeconds,
      oldest,
      newest,
      bars,
      gaps,
      unrecoverableGaps,
      staleMs,
      lastError,
      healthy: bars > 0 && unrecoverableGaps === 0 && lastError === null,
    }
  }

  private async rows(sql: string, bindings: any[]): Promise<any[]> {
    const result: any = await db.rawQuery(sql, bindings)
    const rows = Array.isArray(result?.[0]) ? result[0] : result
    return Array.isArray(rows) ? rows : []
  }

  private async scalarRow(sql: string, bindings: any[]): Promise<any | null> {
    const rows = await this.rows(sql, bindings)
    return rows[0] ?? null
  }

  public status(): Record<string, any> {
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      passes: this.passCount,
      symbols: this.symbols,
      lastErrors: Object.fromEntries(this.lastErrors),
    }
  }
}

export default new BarRecorderService()
export { BarRecorderService }
