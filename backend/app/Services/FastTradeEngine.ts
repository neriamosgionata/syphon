import crypto from 'crypto'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'
import Database from '@ioc:Adonis/Lucid/Database'
import BinanceWS, { ExecutionReport } from 'App/Services/BinanceWebSocketService'

const BINANCE_REST_BASE = 'https://api.binance.com'

// ─── Types ───────────────────────────────────────────────────

export type FastOrderStatus = 'pending' | 'submitted' | 'partially_filled' | 'filled' | 'cancelled' | 'error'

export interface FastOrderState {
  clientOrderId: string
  externalOrderId: string | null
  tradeId: number | null
  tickerId: number | null
  symbol: string
  side: 'BUY' | 'SELL'
  orderType: string
  quantity: number
  limitPrice: number | null
  stopPrice: number | null
  status: FastOrderStatus
  filledQuantity: number
  fillPrice: number | null
  commission: number | null
  commissionAsset: string | null
  submittedAt: number
  filledAt: number | null
  cancelledAt: number | null
  errorMessage: string | null
  dirty: boolean
}

interface FastOrderOpts {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  orderType?: string
  price?: number
  stopPrice?: number
  timeInForce?: string
}

// ─── Service ─────────────────────────────────────────────────

class FastTradeEngine {
  private apiKey: string = ''
  private apiSecret: string = ''

  private orders = new Map<string, FastOrderState>()
  private flushQueue: FastOrderState[] = []
  private pendingFlushIds = new Set<string>()
  private flushing = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushIntervalMs = 100
  private tickerIdCache = new Map<string, number>()

  // Database.connection() returns a QueryClient — dialect info lives on
  // .dialect.name (dialectName on the QueryClient is undefined).
  private get isSqlite(): boolean {
    return Database.connection().dialect.name === 'better-sqlite3'
  }

  private _running = false
  private unsubscribeOrderUpdate: (() => void) | null = null

  public get running(): boolean {
    return this._running
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async start(symbols: string[] = ['BTC', 'ETH', 'SOL']): Promise<void> {
    if (this._running) return
    this.apiKey = Env.get('BINANCE_API_KEY', '')
    this.apiSecret = Env.get('BINANCE_API_SECRET', '')

    if (!this.apiKey || !this.apiSecret) {
      Logger.warn('[FastTrade] API key/secret not configured')
      return
    }

    try {
      // Validate credentials
      await this.validateCredentials()
    } catch {
      Logger.error('[FastTrade] Credential validation failed')
      return
    }

    // Connect WebSocket streams
    try {
      BinanceWS.connectPrices(symbols)
      await BinanceWS.connectUserData()
    } catch (err) {
      Logger.error('[FastTrade] WebSocket connection failed: %s', err.message)
    }

    // Subscribe to order updates (clean up old subscription first)
    if (this.unsubscribeOrderUpdate) this.unsubscribeOrderUpdate()
    this.unsubscribeOrderUpdate = BinanceWS.onOrderUpdate((report) => this.handleExecutionReport(report))

    // Recover active orders from DB
    await this.recoverFromDb()

    // Start flush timer
    this.flushTimer = setInterval(() => this.flushToDb(), this.flushIntervalMs)
    this._running = true
    Logger.info('[FastTrade] Engine started, subscribed to %s', symbols.join(', '))
  }

  public async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    if (this.unsubscribeOrderUpdate) {
      this.unsubscribeOrderUpdate()
      this.unsubscribeOrderUpdate = null
    }
    await this.flushToDb()
    BinanceWS.disconnect()
    Logger.info('[FastTrade] Engine stopped')
  }

  // ---------------------------------------------------------------------------
  // Order placement
  // ---------------------------------------------------------------------------

  public async placeOrder(opts: FastOrderOpts): Promise<FastOrderState> {
    const clientOrderId = crypto.randomUUID()
    const symbol = `${opts.symbol.toUpperCase()}USDT`
    const orderType = opts.orderType || 'MARKET'
    // trades.order_type is an ENUM of IBKR-style codes; map Binance names
    // onto it or every INSERT fails with "Data truncated for column
    // 'order_type'".
    const dbOrderType: Record<string, string> = {
      MARKET: 'MKT',
      LIMIT: 'LMT',
      STOP_LOSS: 'STP',
      STOP_LOSS_LIMIT: 'STP_LMT',
      TRAILING_STOP_MARKET: 'TRAIL',
    }
    const canonicalOrderType = dbOrderType[orderType] || 'MKT'

    // Resolve ticker ID (cached)
    const tickerId = await this.resolveTickerId(opts.symbol.toUpperCase())
    if (tickerId === null) {
      const state: FastOrderState = {
        clientOrderId,
        externalOrderId: null, tradeId: null, tickerId: null,
        symbol: opts.symbol.toUpperCase(), side: opts.side, orderType: canonicalOrderType,
        quantity: opts.quantity, limitPrice: null, stopPrice: null,
        status: 'error', filledQuantity: 0, fillPrice: null,
        commission: null, commissionAsset: null, submittedAt: Date.now(),
        filledAt: null, cancelledAt: null,
        errorMessage: 'Failed to resolve ticker in database', dirty: false,
      }
      this.orders.set(clientOrderId, state)
      this.enqueueFlush(state)
      return state
    }

    const state: FastOrderState = {
      clientOrderId,
      externalOrderId: null,
      tradeId: null,
      tickerId,
      symbol: opts.symbol.toUpperCase(),
      side: opts.side,
      orderType: canonicalOrderType,
      quantity: opts.quantity,
      limitPrice: opts.price || null,
      stopPrice: opts.stopPrice || null,
      status: 'pending',
      filledQuantity: 0,
      fillPrice: null,
      commission: null,
      commissionAsset: null,
      submittedAt: Date.now(),
      filledAt: null,
      cancelledAt: null,
      errorMessage: null,
      dirty: true,
    }

    this.orders.set(clientOrderId, state)
    this.enqueueFlush(state)

    const params: Record<string, any> = {
      symbol,
      side: opts.side,
      type: orderType,
      quantity: opts.quantity,
      newClientOrderId: clientOrderId,
    }

    if (['LIMIT', 'STOP_LOSS_LIMIT'].includes(orderType) && opts.price) {
      params.price = String(opts.price)
      params.timeInForce = opts.timeInForce || 'GTC'
    }
    if (['STOP_LOSS', 'STOP_LOSS_LIMIT'].includes(orderType) && opts.stopPrice) {
      params.stopPrice = String(opts.stopPrice)
    }
    if (orderType === 'TRAILING_STOP_MARKET' && opts.price) {
      params.callbackRate = String(opts.price)
    }

    try {
      const result = await this.signedRequest('/api/v3/order', params, 'POST')
      state.externalOrderId = String(result.orderId)
      // Only set submitted if WS hasn't already advanced status to filled/cancelled
      if (state.status === 'pending') state.status = 'submitted'
      state.dirty = true
      Logger.info('[FastTrade] Order %s: %s %s %s %s (orderId=%s)',
        clientOrderId.slice(0, 8), opts.side, opts.quantity, opts.symbol, orderType, result.orderId)
    } catch (err) {
      if (state.status === 'pending') {
        state.status = 'error'
        state.errorMessage = err.message
      }
      Logger.error('[FastTrade] Order %s failed: %s', clientOrderId.slice(0, 8), err.message)
    }

    return state
  }

  public async cancelOrder(clientOrderId: string): Promise<boolean> {
    const state = this.orders.get(clientOrderId)
    if (!state || !state.externalOrderId) return false
    if (['filled', 'cancelled', 'error'].includes(state.status)) return false

    try {
      const symbol = `${state.symbol}USDT`
      await this.signedRequest('/api/v3/order', {
        symbol,
        orderId: Number(state.externalOrderId),
      }, 'DELETE')
      state.status = 'cancelled'
      state.cancelledAt = Date.now()
      state.dirty = true
      this.enqueueFlush(state)
      return true
    } catch (err) {
      Logger.error('[FastTrade] Cancel %s failed: %s', clientOrderId.slice(0, 8), err.message)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Order state access
  // ---------------------------------------------------------------------------

  public getOrder(clientOrderId: string): FastOrderState | undefined {
    return this.orders.get(clientOrderId)
  }

  public getOrdersBySymbol(symbol: string): FastOrderState[] {
    const up = symbol.toUpperCase()
    return [...this.orders.values()].filter((o) => o.symbol === up)
  }

  public getActiveOrders(): FastOrderState[] {
    return [...this.orders.values()].filter((o) =>
      ['pending', 'submitted', 'partially_filled'].includes(o.status)
    )
  }

  public getAllOrders(): FastOrderState[] {
    return [...this.orders.values()]
  }

  public getPrice(symbol: string): number | null {
    return BinanceWS.getPrice(symbol)
  }

  public getActiveOrderCount(): number {
    let count = 0
    for (const o of this.orders.values()) {
      if (['pending', 'submitted', 'partially_filled'].includes(o.status)) count++
    }
    return count
  }

  // ---------------------------------------------------------------------------
  // WebSocket event handler
  // ---------------------------------------------------------------------------

  private handleExecutionReport(report: ExecutionReport): void {
    const state = this.orders.get(report.c)
    if (!state) return

    const statusMap: Record<string, FastOrderStatus> = {
      NEW: 'submitted',
      PARTIALLY_FILLED: 'partially_filled',
      FILLED: 'filled',
      CANCELED: 'cancelled',
      REJECTED: 'error',
      EXPIRED: 'cancelled',
    }

    const newStatus = statusMap[report.X]
    if (newStatus && state.status !== newStatus) {
      state.status = newStatus
      state.dirty = true
    }

    if (report.z) {
      const cumQty = parseFloat(report.z)
      if (cumQty > 0) state.filledQuantity = cumQty
    }
    if (report.L) {
      const execPrice = parseFloat(report.L)
      if (execPrice > 0) state.fillPrice = execPrice
    }
    if (report.n) {
      state.commission = (state.commission || 0) + parseFloat(report.n)
      state.commissionAsset = report.N || null
    }

    if (report.X === 'FILLED' && report.T) {
      state.filledAt = report.T
    } else if ((report.X === 'CANCELED' || report.X === 'EXPIRED') && report.E) {
      state.cancelledAt = report.E
    }

    this.enqueueFlush(state)
  }

  private enqueueFlush(state: FastOrderState): void {
    if (this.pendingFlushIds.has(state.clientOrderId)) return
    this.pendingFlushIds.add(state.clientOrderId)
    this.flushQueue.push(state)
  }

  private async resolveTickerId(symbol: string): Promise<number | null> {
    if (this.tickerIdCache.has(symbol)) return this.tickerIdCache.get(symbol)!
    try {
      const rows = await Database.rawQuery('SELECT id FROM tickers WHERE symbol = ? LIMIT 1', [symbol])
      const tickers = this.isSqlite ? rows : rows[0]
      if (tickers[0]?.id) {
        this.tickerIdCache.set(symbol, tickers[0].id)
        return tickers[0].id
      }
    } catch { /* SELECT failed, try INSERT */ }

    try {
      const insertSql = this.isSqlite
        ? 'INSERT OR IGNORE INTO tickers (symbol, name, is_active) VALUES (?, ?, 1)'
        : 'INSERT IGNORE INTO tickers (symbol, name, is_active) VALUES (?, ?, 1)'
      await Database.rawQuery(insertSql, [symbol, symbol])
      const rows = await Database.rawQuery('SELECT id FROM tickers WHERE symbol = ? LIMIT 1', [symbol])
      const tickers = this.isSqlite ? rows : rows[0]
      const id = tickers[0]?.id || null
      if (id) this.tickerIdCache.set(symbol, id)
      return id
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Database flush
  // ---------------------------------------------------------------------------

  private async flushToDb(): Promise<void> {
    if (this.flushQueue.length === 0) return
    if (this.flushing) return
    this.flushing = true

    const batch = this.flushQueue.splice(0)

    // Timeout guard: a hung DB must not wedge the flush loop forever
    // (flushing stays true, in-memory queue grows unbounded).
    let failed = false
    const persist = this.persistBatch(batch).catch((err) => {
      failed = true
      Logger.error('[FastTrade] DB flush failed (%d orders): %s', batch.length, err.message)
    })

    const outcome = await Promise.race([
      persist.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10000)),
    ])

    if (outcome === 'timeout') {
      // Let the in-flight transaction settle (commit or rollback) before
      // re-queueing, so a concurrent retry can't double-INSERT the same
      // orders. If it committed, state.tradeId was assigned and the next
      // flush takes the UPDATE path.
      Logger.warn('[FastTrade] Flush exceeded 10s, waiting for settlement')
      await persist
    }

    if (failed) {
      this.flushQueue.unshift(...batch)
    } else {
      for (const state of batch) this.pendingFlushIds.delete(state.clientOrderId)
    }

    this.flushing = false
  }

  private async persistBatch(batch: FastOrderState[]): Promise<void> {
    const trx = await Database.transaction()

    try {
      for (const state of batch) {
        if (state.tradeId) {
          const updateResult = await trx.rawQuery(`
            UPDATE trades
            SET status = ?, filled_quantity = ?, fill_price = ?,
                commission = ?, error_message = ?,
                filled_at = ?, cancelled_at = ?, updated_at = NOW()
            WHERE id = ?
          `, [
            state.status,
            state.filledQuantity,
            state.fillPrice,
            state.commission,
            state.errorMessage,
            state.filledAt ? new Date(state.filledAt).toISOString().slice(0, 19).replace('T', ' ') : null,
            state.cancelledAt ? new Date(state.cancelledAt).toISOString().slice(0, 19).replace('T', ' ') : null,
            state.tradeId,
          ])
          // MySQL exposes affectedRows; better-sqlite3 returns { changes }.
          const affected = Number(
            updateResult?.affectedRows ?? updateResult?.changes ?? 0
          )
          // Row missing (e.g. a previous INSERT was rolled back after the
          // in-memory tradeId was assigned) — fall back to INSERT.
          if (affected === 0) {
            state.tradeId = null
            await this.insertTradeRow(trx, state)
          }
        } else {
          await this.insertTradeRow(trx, state)
        }
        state.dirty = false
      }

      await trx.commit()
    } catch (err) {
      await trx.rollback()
      throw err
    }
  }

  private async insertTradeRow(trx: any, state: FastOrderState): Promise<void> {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const result = await trx.rawQuery(`
      INSERT INTO trades
        (ticker_id, symbol, side, order_type, quantity, limit_price, stop_price,
         external_order_id, client_order_id, status, filled_quantity, fill_price,
         commission, error_message, broker, exchange, currency,
         time_in_force, submitted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      state.tickerId,
      state.symbol,
      state.side,
      state.orderType,
      state.quantity,
      state.limitPrice,
      state.stopPrice,
      state.externalOrderId,
      state.clientOrderId,
      state.status,
      state.filledQuantity,
      state.fillPrice,
      state.commission,
      state.errorMessage,
      'binance',
      'spot',
      'USDT',
      'GTC',
      state.submittedAt ? new Date(state.submittedAt).toISOString().slice(0, 19).replace('T', ' ') : now,
      now,
      now,
    ])
    // MySQL ResultSetHeader exposes insertId; better-sqlite3 returns
    // { lastInsertRowid }.
    state.tradeId = Number(result?.insertId ?? result?.lastInsertRowid)
  }

  // ---------------------------------------------------------------------------
  // Recovery: load pending orders from DB & sync with Binance
  // ---------------------------------------------------------------------------

  private async recoverFromDb(): Promise<void> {
    try {
      const rows = await Database.rawQuery(`
        SELECT id, symbol, side, order_type, quantity, limit_price, stop_price,
               external_order_id, client_order_id, status, filled_quantity, fill_price, commission,
               submitted_at, error_message, ticker_id
        FROM trades
        WHERE broker = 'binance' AND status IN ('pending', 'submitted', 'partially_filled')
        ORDER BY created_at DESC
        LIMIT 50
      `)

      const trades = this.isSqlite ? rows : rows[0]
      const recovered: FastOrderState[] = []
      for (const row of trades) {
        if (!row.external_order_id) continue
        const clientOrderId = row.client_order_id || crypto.randomUUID()

        const state: FastOrderState = {
          clientOrderId,
          externalOrderId: String(row.external_order_id),
          tradeId: row.id,
          tickerId: row.ticker_id || null,
          symbol: row.symbol,
          side: row.side,
          orderType: row.order_type,
          quantity: Number(row.quantity),
          limitPrice: row.limit_price ? Number(row.limit_price) : null,
          stopPrice: row.stop_price ? Number(row.stop_price) : null,
          status: row.status as FastOrderStatus,
          filledQuantity: Number(row.filled_quantity) || 0,
          fillPrice: row.fill_price ? Number(row.fill_price) : null,
          commission: row.commission ? Number(row.commission) : null,
          commissionAsset: null,
          submittedAt: row.submitted_at ? new Date(row.submitted_at).getTime() : Date.now(),
          filledAt: null,
          cancelledAt: null,
          errorMessage: row.error_message || null,
          dirty: false,
        }

        this.orders.set(clientOrderId, state)
        recovered.push(state)
      }

      Logger.info('[FastTrade] Recovered %d active orders from DB', trades.length)

      // Sync recovered orders against the exchange so fills/statuses missed
      // while the engine was down (or orders without a persisted
      // client_order_id) converge to their true state.
      await this.reconcileWithExchange(recovered)
    } catch (err) {
      Logger.error('[FastTrade] DB recovery failed: %s', err.message)
    }
  }

  /**
   * Query Binance for the current state of recovered orders and apply it.
   * Needed because execution reports are keyed by the original clientOrderId,
   * which legacy rows (and any order placed before the client_order_id column
   * existed) do not have persisted.
   */
  private async reconcileWithExchange(states: FastOrderState[]): Promise<void> {
    const pending = states.filter(
      (s) => s.externalOrderId && ['pending', 'submitted', 'partially_filled'].includes(s.status)
    )
    if (pending.length === 0) return

    await Promise.allSettled(
      pending.map(async (state) => {
        try {
          const symbol = `${state.symbol}USDT`
          const result = await this.signedRequest('/api/v3/order', {
            symbol,
            orderId: Number(state.externalOrderId),
          })

          const statusMap: Record<string, FastOrderStatus> = {
            NEW: 'submitted',
            PARTIALLY_FILLED: 'partially_filled',
            FILLED: 'filled',
            CANCELED: 'cancelled',
            REJECTED: 'error',
            EXPIRED: 'cancelled',
          }

          const newStatus = statusMap[result.status]
          if (newStatus && state.status !== newStatus) {
            state.status = newStatus
            state.dirty = true
          }

          const volExec = parseFloat(result.executedQty || '0')
          if (volExec > 0) state.filledQuantity = volExec
          const quoteQty = parseFloat(result.cummulativeQuoteQty || '0')
          if (volExec > 0 && quoteQty > 0) state.fillPrice = quoteQty / volExec

          const eventTime = result.updateTime || result.time || Date.now()
          if (newStatus === 'filled' && !state.filledAt) state.filledAt = eventTime
          else if (newStatus === 'cancelled' && !state.cancelledAt) state.cancelledAt = eventTime

          this.enqueueFlush(state)
        } catch (err) {
          Logger.warn('[FastTrade] Exchange reconcile failed for %s: %s', state.symbol, err.message)
        }
      })
    )
  }

  public pruneCompletedOrders(maxAgeMs: number = 3600000): number {
    const now = Date.now()
    let removed = 0
    for (const [id, state] of this.orders) {
      if (['filled', 'cancelled', 'error'].includes(state.status)) {
        if (now - state.submittedAt > maxAgeMs) {
          this.orders.delete(id)
          removed++
        }
      }
    }
    return removed
  }

  // ---------------------------------------------------------------------------
  // REST helpers
  // ---------------------------------------------------------------------------

  private async validateCredentials(): Promise<void> {
    const qs = new URLSearchParams({ timestamp: String(Date.now()) }).toString()
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex')
    const res = await fetch(`${BINANCE_REST_BASE}/api/v3/account?${qs}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
    })
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 200)}`) }
    if (json.code && json.msg) throw new Error(json.msg)
  }

  private async signedRequest(path: string, params: Record<string, any>, method: string = 'GET'): Promise<any> {
    const allParams = { ...params, timestamp: Date.now() }
    const qs = new URLSearchParams(allParams as any).toString()
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex')
    const url = `${BINANCE_REST_BASE}${path}?${qs}&signature=${sig}`

    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    })

    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 200)}`) }
    if (json.code && json.msg) throw new Error(json.msg)
    return json
  }
}

export default new FastTradeEngine()
