import crypto from 'crypto'
import querystring from 'querystring'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import KrakenWS, { KrakenOrderUpdate } from '#services/KrakenWebSocketService'

const KRAKEN_REST_BASE = 'https://api.kraken.com'

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

// ─── Kraken signing + pair helpers ───────────────────────────

/**
 * Generate Kraken API-Sign header.
 * HMAC-SHA512 of (URI path + SHA256(nonce + POST data)), keyed with base64-decoded secret.
 */
function getKrakenSignature(urlPath: string, data: Record<string, any>, secret: string): string {
  const dataStr = querystring.stringify(data)
  const encoded = data.nonce + dataStr
  const sha256Hash = crypto.createHash('sha256').update(encoded).digest()
  const message = Buffer.concat([Buffer.from(urlPath), sha256Hash])
  const secretBuffer = Buffer.from(secret, 'base64')
  return crypto.createHmac('sha512', secretBuffer).update(message).digest('base64')
}

// Kraken uses XBT instead of BTC; REST pairs have no slash (XBTUSD).
function toRestPair(symbol: string, currency = 'USD'): string {
  const base = symbol.toUpperCase() === 'BTC' ? 'XBT' : symbol.toUpperCase()
  return `${base}${currency.toUpperCase()}`
}

// ─── Service ─────────────────────────────────────────────────

class KrakenFastEngine {
  private apiKey: string = ''
  private apiSecret: string = ''
  private currency: string = 'USD'

  constructor(private database: {
    connection: () => { dialect: { name: string } }
    rawQuery: (sql: string, params?: any[]) => Promise<any>
    transaction: () => Promise<any>
  } = db) {}

  private orders = new Map<string, FastOrderState>()
  private flushQueue: FastOrderState[] = []
  private pendingFlushIds = new Set<string>()
  private flushing = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushIntervalMs = 100
  private tickerIdCache = new Map<string, number>()
  private lastNonce = 0

  private get isSqlite(): boolean {
    return this.database.connection().dialect.name === 'better-sqlite3'
  }

  // Kraken requires strictly increasing nonces per API key.
  private nextNonce(): number {
    const base = Date.now() * 1000
    this.lastNonce = Math.max(base, this.lastNonce + 1)
    return this.lastNonce
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
    this.apiKey = env.get('KRAKEN_API_KEY', '')
    this.apiSecret = env.get('KRAKEN_API_SECRET', '')

    if (!this.apiKey || !this.apiSecret) {
      logger.warn('[KrakenFast] API key/secret not configured')
      return
    }

    try {
      await this.validateCredentials()
    } catch {
      logger.error('[KrakenFast] Credential validation failed')
      return
    }

    // Connect WebSocket streams
    try {
      KrakenWS.connectPrices(symbols)
      await KrakenWS.connectUserData()
    } catch (err) {
      logger.error('[KrakenFast] WebSocket connection failed: %s', (err as Error).message)
    }

    if (this.unsubscribeOrderUpdate) this.unsubscribeOrderUpdate()
    this.unsubscribeOrderUpdate = KrakenWS.onOrderUpdate((update) => this.handleOrderUpdate(update))

    await this.recoverFromDb()

    this.flushTimer = setInterval(() => this.flushToDb(), this.flushIntervalMs)
    this._running = true
    logger.info('[KrakenFast] Engine started, subscribed to %s', symbols.join(', '))
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
    KrakenWS.disconnect()
    logger.info('[KrakenFast] Engine stopped')
  }

  // ---------------------------------------------------------------------------
  // Order placement
  // ---------------------------------------------------------------------------

  public async placeOrder(opts: FastOrderOpts): Promise<FastOrderState> {
    const clientOrderId = crypto.randomUUID()
    const pair = toRestPair(opts.symbol.toUpperCase(), this.currency)
    const orderType = opts.orderType || 'MARKET'
    // trades.order_type is an ENUM of IBKR-style codes; map Kraken names
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

    const krakenOrderTypeMap: Record<string, string> = {
      MKT: 'market',
      LMT: 'limit',
      STP: 'stop-loss',
      STP_LMT: 'stop-loss-limit',
      TRAIL: 'trailing-stop',
    }

    const params: Record<string, any> = {
      pair,
      type: opts.side.toLowerCase(),
      ordertype: krakenOrderTypeMap[canonicalOrderType] || 'market',
      volume: String(opts.quantity),
      // Long-UUID cl_ord_id lets the WS openOrders stream (which carries
      // cl_ord_id) map execution reports straight back onto this client order.
      cl_ord_id: clientOrderId,
    }

    // Price params
    if (['LMT', 'STP_LMT'].includes(canonicalOrderType) && opts.price) {
      params.price = String(opts.price)
      params.timeinforce = opts.timeInForce || 'GTC'
    }
    if (['STP', 'STP_LMT'].includes(canonicalOrderType) && opts.stopPrice) {
      params.price = String(opts.stopPrice)
      if (canonicalOrderType === 'STP_LMT' && opts.price) {
        params.price2 = String(opts.price)
      }
    }
    if (canonicalOrderType === 'TRAIL' && opts.price) {
      // Kraken trailing-stop: `price` = activation price (numeric), `price2`
      // = trailing offset (with +/- prefix). Mirrors KrakenService.placeOrder.
      if (opts.stopPrice) params.price = String(opts.stopPrice)
      params.price2 = `+${opts.price}`
    }

    try {
      const result = await this.privateRequest('/0/private/AddOrder', params)
      state.externalOrderId = result?.txid?.[0] || null
      // Only set submitted if WS hasn't already advanced status to filled/cancelled
      if (state.status === 'pending') state.status = 'submitted'
      state.dirty = true
      logger.info('[KrakenFast] Order %s: %s %s %s %s (txid=%s)',
        clientOrderId.slice(0, 8), opts.side, opts.quantity, opts.symbol, orderType, state.externalOrderId)
    } catch (err) {
      if (state.status === 'pending') {
        state.status = 'error'
        state.errorMessage = (err as Error).message
      }
      logger.error('[KrakenFast] Order %s failed: %s', clientOrderId.slice(0, 8), (err as Error).message)
    }

    return state
  }

  public async cancelOrder(clientOrderId: string): Promise<boolean> {
    const state = this.orders.get(clientOrderId)
    if (!state || !state.externalOrderId) return false
    if (['filled', 'cancelled', 'error'].includes(state.status)) return false

    try {
      await this.privateRequest('/0/private/CancelOrder', { txid: state.externalOrderId })
      state.status = 'cancelled'
      state.cancelledAt = Date.now()
      state.dirty = true
      this.enqueueFlush(state)
      return true
    } catch (err) {
      logger.error('[KrakenFast] Cancel %s failed: %s', clientOrderId.slice(0, 8), (err as Error).message)
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
    return KrakenWS.getPrice(symbol)
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

  private handleOrderUpdate(update: KrakenOrderUpdate): void {
    const state = update.cl_ord_id ? this.orders.get(update.cl_ord_id) : undefined
    if (!state) return

    const vol = parseFloat(update.vol || '0')
    const volExec = parseFloat(update.vol_exec || '0')

    let newStatus: FastOrderStatus | undefined
    if (update.status === 'closed') {
      newStatus = 'filled'
    } else if (update.status === 'canceled' || update.status === 'expired') {
      newStatus = 'cancelled'
    } else if (update.status === 'open') {
      if (vol > 0 && volExec >= vol) newStatus = 'filled'
      else if (volExec > 0) newStatus = 'partially_filled'
      else newStatus = 'submitted'
    } else if (update.status === 'pending') {
      newStatus = 'submitted'
    }

    if (newStatus && state.status !== newStatus) {
      state.status = newStatus
      state.dirty = true
    }

    if (volExec > 0) state.filledQuantity = volExec

    if (update.avg_price) {
      const ap = parseFloat(update.avg_price)
      if (ap > 0) state.fillPrice = ap
    } else if (update.cost && volExec > 0) {
      state.fillPrice = parseFloat(update.cost) / volExec
    }

    if (update.fee) {
      const fee = parseFloat(update.fee)
      if (fee > 0) {
        state.commission = fee
        state.commissionAsset = this.currency
      }
    }

    if (update.lastupdated) {
      const t = Math.round(parseFloat(update.lastupdated) * 1000)
      if (newStatus === 'filled' && !state.filledAt) state.filledAt = t
      else if (newStatus === 'cancelled' && !state.cancelledAt) state.cancelledAt = t
    }

    // Kraken close updates are status-only ({ status: "closed" }) — they drop
    // vol_exec/avg_price/fee. Backfill the final fill data from REST so a
    // same-tick market fill isn't left with filledQuantity = 0.
    if (
      (update.status === 'closed' || update.status === 'canceled') &&
      update.vol_exec === undefined &&
      state.externalOrderId
    ) {
      void this.reconcileOne(state)
    }

    this.enqueueFlush(state)
  }

  private async reconcileOne(state: FastOrderState): Promise<void> {
    if (!state.externalOrderId) return
    try {
      const result = await this.privateRequest('/0/private/QueryOrders', { txid: state.externalOrderId })
      const order = result?.[state.externalOrderId]
      if (!order) return

      const volExec = parseFloat(order.vol_exec || '0')
      if (volExec > 0) state.filledQuantity = volExec
      if (order.avg_price && parseFloat(order.avg_price) > 0) {
        state.fillPrice = parseFloat(order.avg_price)
      }
      if (order.fee && parseFloat(order.fee) > 0) {
        state.commission = parseFloat(order.fee)
        state.commissionAsset = this.currency
      }
      state.dirty = true
      this.enqueueFlush(state)
    } catch (err) {
      logger.warn('[KrakenFast] Reconcile failed for %s: %s', state.symbol, (err as Error).message)
    }
  }

  private enqueueFlush(state: FastOrderState): void {
    if (this.pendingFlushIds.has(state.clientOrderId)) return
    this.pendingFlushIds.add(state.clientOrderId)
    this.flushQueue.push(state)
  }

  private async resolveTickerId(symbol: string): Promise<number | null> {
    if (this.tickerIdCache.has(symbol)) return this.tickerIdCache.get(symbol)!
    try {
      const rows = await this.database.rawQuery('SELECT id FROM tickers WHERE symbol = ? LIMIT 1', [symbol])
      const tickers = this.isSqlite ? rows : rows[0]
      if (tickers[0]?.id) {
        this.tickerIdCache.set(symbol, tickers[0].id)
        return tickers[0].id
      }
    } catch { /* SELECT failed, try INSERT */ }

    try {
      const insertSql = this.isSqlite
        ? "INSERT OR IGNORE INTO tickers (symbol, name, is_active, sec_type, exchange, currency) VALUES (?, ?, 1, 'crypto', 'KRAKEN', 'USD')"
        : "INSERT IGNORE INTO tickers (symbol, name, is_active, sec_type, exchange, currency) VALUES (?, ?, 1, 'crypto', 'KRAKEN', 'USD')"
      await this.database.rawQuery(insertSql, [symbol, symbol])
      const rows = await this.database.rawQuery('SELECT id FROM tickers WHERE symbol = ? LIMIT 1', [symbol])
      const tickers = this.isSqlite ? rows : rows[0]
      const id = tickers[0]?.id || null
      if (id) this.tickerIdCache.set(symbol, id)
      return id
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // db flush
  // ---------------------------------------------------------------------------

  private async flushToDb(): Promise<void> {
    if (this.flushQueue.length === 0) return
    if (this.flushing) return
    this.flushing = true

    const batch = this.flushQueue.splice(0)

    let failed = false
    const persist = this.persistBatch(batch).catch((err) => {
      failed = true
      logger.error('[KrakenFast] DB flush failed (%d orders): %s', batch.length, (err as Error).message)
    })

    const outcome = await Promise.race([
      persist.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10000)),
    ])

    if (outcome === 'timeout') {
      logger.warn('[KrakenFast] Flush exceeded 10s, waiting for settlement')
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
    const trx = await this.database.transaction()

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
          const affected = Number(
            updateResult?.affectedRows ?? updateResult?.changes ?? 0
          )
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
      'kraken',
      'spot',
      this.currency,
      'GTC',
      state.submittedAt ? new Date(state.submittedAt).toISOString().slice(0, 19).replace('T', ' ') : now,
      now,
      now,
    ])
    state.tradeId = Number(result?.insertId ?? result?.lastInsertRowid)
  }

  // ---------------------------------------------------------------------------
  // Recovery: load pending orders from DB & sync with Kraken
  // ---------------------------------------------------------------------------

  private async recoverFromDb(): Promise<void> {
    try {
      const rows = await this.database.rawQuery(`
        SELECT id, symbol, side, order_type, quantity, limit_price, stop_price,
               external_order_id, client_order_id, status, filled_quantity, fill_price, commission,
               submitted_at, error_message, ticker_id
        FROM trades
        WHERE broker = 'kraken' AND client_order_id IS NOT NULL
          AND status IN ('pending', 'submitted', 'partially_filled')
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

      logger.info('[KrakenFast] Recovered %d active orders from DB', trades.length)

      await this.reconcileWithExchange(recovered)
    } catch (err) {
      logger.error('[KrakenFast] DB recovery failed: %s', (err as Error).message)
    }
  }

  /**
   * Query Kraken for the current state of recovered orders and apply it.
   * Needed because execution reports are keyed by cl_ord_id, which legacy rows
   * (and orders placed before the cl_ord_id column existed) do not have.
   */
  private async reconcileWithExchange(states: FastOrderState[]): Promise<void> {
    const pending = states.filter(
      (s) => s.externalOrderId && ['pending', 'submitted', 'partially_filled'].includes(s.status)
    )
    if (pending.length === 0) return

    await Promise.allSettled(
      pending.map(async (state) => {
        try {
          const result = await this.privateRequest('/0/private/QueryOrders', { txid: state.externalOrderId! })
          const order = result?.[state.externalOrderId!]
          if (!order) return

          const vol = parseFloat(order.vol || '0')
          const volExec = parseFloat(order.vol_exec || '0')

          const statusMap: Record<string, FastOrderStatus> = {
            open: 'submitted',
            closed: 'filled',
            canceled: 'cancelled',
            expired: 'cancelled',
          }

          let newStatus = statusMap[order.status]
          if (newStatus === 'submitted' && vol > 0 && volExec > 0 && volExec < vol) {
            newStatus = 'partially_filled'
          }
          if (newStatus === 'submitted' && vol > 0 && volExec >= vol) {
            newStatus = 'filled'
          }

          if (newStatus && state.status !== newStatus) {
            state.status = newStatus
            state.dirty = true
          }

          if (volExec > 0) state.filledQuantity = volExec
          if (order.avg_price && parseFloat(order.avg_price) > 0) {
            state.fillPrice = parseFloat(order.avg_price)
          }
          if (order.fee && parseFloat(order.fee) > 0) {
            state.commission = parseFloat(order.fee)
            state.commissionAsset = this.currency
          }

          if (newStatus === 'filled' && !state.filledAt) state.filledAt = Date.now()
          else if (newStatus === 'cancelled' && !state.cancelledAt) state.cancelledAt = Date.now()

          this.enqueueFlush(state)
        } catch (err) {
          logger.warn('[KrakenFast] Exchange reconcile failed for %s: %s', state.symbol, (err as Error).message)
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
    await this.privateRequest('/0/private/Balance', {})
  }

  private async privateRequest(path: string, params: Record<string, any> = {}): Promise<any> {
    const nonce = this.nextNonce()
    const body = { nonce, ...params }
    const signature = getKrakenSignature(path, body, this.apiSecret)

    const res = await fetch(`${KRAKEN_REST_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': this.apiKey,
        'API-Sign': signature,
      },
      body: querystring.stringify(body),
    })

    const json: any = await res.json()
    if (json.error && json.error.length > 0) {
      throw new Error(json.error.join('; '))
    }
    return json.result
  }
}

export { KrakenFastEngine }

export default new KrakenFastEngine()
