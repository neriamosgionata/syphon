// ─── IBKR fast execution engine ────────────────────────────────
//
// FastExecutionEngine implementation over TWS/Gateway — the stock/ETF
// side of the fast algo. Mirrors KrakenFastEngine's lifecycle exactly:
// same FastOrderState machine, same 100ms batched DB flush, same trade
// linking (client_order_id → algo position) and same crash recovery.
//
// Execution reports map back onto client orders via:
//   orderStatus  → orderId (engine allocates and tracks the int ids)
//   execDetails  → execution.orderRef = clientOrderId (uuid)
//   commission   → permId (seen first in orderStatus)
// Orders are DAY by default (equity convention) — the algo's entry/exit
// loop always works with the market open, so day orders clear cleanly.

import crypto from 'crypto'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import Ticker from '#models/Ticker'
import IBKRService from '#services/IBKRService'
import { contractForTicker } from '#services/ibkr_contracts'
import type { FastExecutionEngine, FastOrderRequest, FastOrderState } from '#services/market_types'

const IB_STATUS_MAP: Record<string, FastOrderState['status']> = {
  PendingSubmit: 'submitted',
  PreSubmitted: 'submitted',
  Submitted: 'submitted',
  ApiPending: 'submitted',
  Filled: 'filled',
  Cancelled: 'cancelled',
  ApiCancelled: 'cancelled',
  PendingCancel: 'submitted',
  Inactive: 'cancelled',
}

const ACTIVE_STATUSES = ['pending', 'submitted', 'partially_filled']

export class IBKRFastEngine implements FastExecutionEngine {
  private orders = new Map<string, FastOrderState>()
  private orderIdMap = new Map<number, string>()
  private permIdMap = new Map<string, string>()
  private flushQueue: FastOrderState[] = []
  private pendingFlushIds = new Set<string>()
  private flushing = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushIntervalMs = 100
  private tickerCache = new Map<string, any>()

  private _running = false
  private unsubscribers: Array<() => void> = []

  constructor(
    private database: any = db,
    private ibkr: any = IBKRService,
    private tickerModel: typeof Ticker = Ticker
  ) {}

  public get running(): boolean {
    return this._running
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async start(symbols: string[] = []): Promise<void> {
    if (this._running) return
    if (!this.ibkr.isConnected) {
      const ok = await this.ibkr.connect()
      if (!ok) {
        logger.warn('[IBKRFast] TWS/Gateway not reachable — engine stays down')
        return
      }
    }

    this.unsubscribers.push(
      this.ibkr.on('orderStatus', (orderId: number, status: string, filled: number, _remaining: number, avgFillPrice: number, permId: number) =>
        this.handleOrderStatus(orderId, status, filled, avgFillPrice, String(permId))),
      this.ibkr.on('execDetails', (_reqId: number, contract: any, execution: any) =>
        this.handleExec(contract, execution)),
      this.ibkr.on('commissionReport', (report: any) => this.handleCommission(report)),
    )

    await this.recoverFromDb()

    this.flushTimer = setInterval(() => void this.flushToDb(), this.flushIntervalMs)
    this._running = true
    logger.info('[IBKRFast] Engine started%s', symbols.length ? `, contracts cached for ${symbols.join(', ')}` : '')
  }

  public async stop(): Promise<void> {
    if (!this._running) return
    this._running = false
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    for (const un of this.unsubscribers) {
      try { un() } catch { /* already gone */ }
    }
    this.unsubscribers = []
    await this.flushToDb()
    logger.info('[IBKRFast] Engine stopped')
  }

  // ---------------------------------------------------------------------------
  // Order placement
  // ---------------------------------------------------------------------------

  public async placeOrder(opts: FastOrderRequest): Promise<FastOrderState> {
    const clientOrderId = crypto.randomUUID()
    const symbol = opts.symbol.toUpperCase()
    const orderType = (opts.orderType || 'MARKET').toUpperCase()
    const dbOrderType: Record<string, string> = { MARKET: 'MKT', LIMIT: 'LMT' }
    const canonicalOrderType = dbOrderType[orderType] || (orderType === 'MKT' ? 'MKT' : orderType)

    const ticker = await this.resolveTicker(symbol)
    if (!ticker) {
      const state = this.failedState(clientOrderId, symbol, opts, canonicalOrderType,
        'No ticker row with contract metadata for this symbol')
      this.orders.set(clientOrderId, state)
      this.enqueueFlush(state)
      return state
    }

    const state: FastOrderState = {
      clientOrderId,
      externalOrderId: null,
      tradeId: null,
      tickerId: ticker.id,
      symbol,
      side: opts.side,
      orderType: canonicalOrderType,
      quantity: opts.quantity,
      limitPrice: opts.price || null,
      stopPrice: null,
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

    try {
      const orderId = await this.ibkr.allocateOrderId()
      const contract = contractForTicker(ticker)
      const order = this.ibkr.buildOrder(orderId, opts.side, canonicalOrderType, opts.quantity, {
        limitPrice: opts.price || null,
        stopPrice: null,
        timeInForce: opts.timeInForce || 'DAY',
        orderRef: clientOrderId,
      })
      await this.ibkr.placeRawOrder(orderId, contract, order)

      state.externalOrderId = String(orderId)
      this.orderIdMap.set(orderId, clientOrderId)
      if (state.status === 'pending') state.status = 'submitted'
      state.dirty = true
      logger.info('[IBKRFast] Order %s: %s %s %s %s (orderId=%d)',
        clientOrderId.slice(0, 8), opts.side, opts.quantity, symbol, orderType, orderId)
    } catch (err) {
      if (state.status === 'pending') {
        state.status = 'error'
        state.errorMessage = (err as Error).message
      }
      logger.error('[IBKRFast] Order %s failed: %s', clientOrderId.slice(0, 8), (err as Error).message)
    }

    return state
  }

  public async cancelOrder(clientOrderId: string): Promise<boolean> {
    const state = this.orders.get(clientOrderId)
    if (!state || !state.externalOrderId) return false
    if (['filled', 'cancelled', 'error'].includes(state.status)) return false

    try {
      await this.ibkr.cancelRawOrder(Number(state.externalOrderId))
      state.status = 'cancelled'
      state.cancelledAt = Date.now()
      state.dirty = true
      this.enqueueFlush(state)
      return true
    } catch (err) {
      logger.error('[IBKRFast] Cancel %s failed: %s', clientOrderId.slice(0, 8), (err as Error).message)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleOrderStatus(orderId: number, ibStatus: string, filled: number, avgFillPrice: number, permId: string): void {
    const clientOrderId = this.orderIdMap.get(orderId)
    const state = clientOrderId ? this.orders.get(clientOrderId) : undefined
    if (!state) return

    if (permId) this.permIdMap.set(permId, state.clientOrderId)

    const newStatus = IB_STATUS_MAP[ibStatus]
    if (newStatus && state.status !== newStatus) {
      state.status = newStatus
      state.dirty = true
      if (newStatus === 'filled' && !state.filledAt) state.filledAt = Date.now()
      else if (newStatus === 'cancelled' && !state.cancelledAt) state.cancelledAt = Date.now()
    }
    if (filled > 0) state.filledQuantity = filled
    if (avgFillPrice > 0) state.fillPrice = avgFillPrice
    this.enqueueFlush(state)
  }

  private handleExec(contract: any, execution: any): void {
    const byRef = execution.orderRef ? this.orders.get(execution.orderRef) : undefined
    const byId = this.orderIdMap.get(execution.orderId)
    const state = byRef ?? (byId ? this.orders.get(byId) : undefined)
    if (!state) return

    const cumQty = Number(execution.cumQty || 0)
    const avgPrice = Number(execution.avgPrice || 0)
    if (cumQty > 0) {
      state.filledQuantity = cumQty
      state.status = cumQty >= state.quantity ? 'filled' : 'partially_filled'
      state.dirty = true
      if (state.status === 'filled' && !state.filledAt) state.filledAt = Date.now()
    }
    if (avgPrice > 0) state.fillPrice = avgPrice
    this.enqueueFlush(state)
  }

  private handleCommission(report: any): void {
    if (!report.permId) return
    const clientOrderId = this.permIdMap.get(String(report.permId))
    const state = clientOrderId ? this.orders.get(clientOrderId) : undefined
    if (!state) return

    const commission = Number(report.commission || 0)
    if (commission > 0) {
      state.commission = commission
      state.commissionAsset = report.currency || 'USD'
      state.dirty = true
      this.enqueueFlush(state)
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
    return [...this.orders.values()].filter((o) => ACTIVE_STATUSES.includes(o.status))
  }

  public getAllOrders(): FastOrderState[] {
    return [...this.orders.values()]
  }

  public getActiveOrderCount(): number {
    return this.getActiveOrders().length
  }

  public pruneCompletedOrders(maxAgeMs: number = 3600000): number {
    const now = Date.now()
    let removed = 0
    for (const [id, state] of this.orders) {
      if (['filled', 'cancelled', 'error'].includes(state.status)) {
        if (now - state.submittedAt > maxAgeMs) {
          this.orders.delete(id)
          this.orderIdMap.delete(Number(state.externalOrderId))
          removed++
        }
      }
    }
    return removed
  }

  // ---------------------------------------------------------------------------
  // Ticker/contract resolution
  // ---------------------------------------------------------------------------

  private async resolveTicker(symbol: string): Promise<any | null> {
    if (this.tickerCache.has(symbol)) return this.tickerCache.get(symbol) ?? null
    try {
      const ticker = await this.tickerModel.findBy('symbol', symbol)
      if (!ticker || !ticker.secType) {
        this.tickerCache.set(symbol, null)
        return null
      }
      this.tickerCache.set(symbol, ticker)
      return ticker
    } catch {
      return null
    }
  }

  private failedState(
    clientOrderId: string,
    symbol: string,
    opts: FastOrderRequest,
    orderType: string,
    message: string
  ): FastOrderState {
    return {
      clientOrderId,
      externalOrderId: null, tradeId: null, tickerId: null,
      symbol, side: opts.side, orderType,
      quantity: opts.quantity, limitPrice: opts.price || null, stopPrice: null,
      status: 'error', filledQuantity: 0, fillPrice: null,
      commission: null, commissionAsset: null, submittedAt: Date.now(),
      filledAt: null, cancelledAt: null, errorMessage: message, dirty: false,
    }
  }

  // ---------------------------------------------------------------------------
  // DB flush (mirrors KrakenFastEngine)
  // ---------------------------------------------------------------------------

  private enqueueFlush(state: FastOrderState): void {
    if (this.pendingFlushIds.has(state.clientOrderId)) return
    this.pendingFlushIds.add(state.clientOrderId)
    this.flushQueue.push(state)
  }

  private async flushToDb(): Promise<void> {
    if (this.flushQueue.length === 0 || this.flushing) return
    this.flushing = true

    const batch = this.flushQueue.splice(0)
    let failed = false
    const persist = this.persistBatch(batch).catch((err) => {
      failed = true
      logger.error('[IBKRFast] DB flush failed (%d orders): %s', batch.length, (err as Error).message)
    })
    await Promise.race([
      persist.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10000)),
    ]).then(async (outcome) => {
      if (outcome === 'timeout') {
        logger.warn('[IBKRFast] Flush exceeded 10s, waiting for settlement')
        await persist
      }
    })

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
            state.status, state.filledQuantity, state.fillPrice, state.commission,
            state.errorMessage,
            state.filledAt ? new Date(state.filledAt).toISOString().slice(0, 19).replace('T', ' ') : null,
            state.cancelledAt ? new Date(state.cancelledAt).toISOString().slice(0, 19).replace('T', ' ') : null,
            state.tradeId,
          ])
          const affected = Number(updateResult?.affectedRows ?? updateResult?.changes ?? 0)
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
      state.tickerId, state.symbol, state.side, state.orderType, state.quantity,
      state.limitPrice, state.stopPrice, state.externalOrderId, state.clientOrderId,
      state.status, state.filledQuantity, state.fillPrice, state.commission,
      state.errorMessage, 'ibkr', 'SMART', state.commissionAsset || 'USD',
      'DAY',
      state.submittedAt ? new Date(state.submittedAt).toISOString().slice(0, 19).replace('T', ' ') : now,
      now, now,
    ])
    state.tradeId = Number(result?.insertId ?? result?.lastInsertRowid)
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  private async recoverFromDb(): Promise<void> {
    try {
      const rows = await this.database.rawQuery(`
        SELECT id, symbol, side, order_type, quantity, limit_price, stop_price,
               external_order_id, client_order_id, status, filled_quantity, fill_price,
               commission, submitted_at, error_message, ticker_id
        FROM trades
        WHERE broker = 'ibkr' AND client_order_id IS NOT NULL
          AND status IN ('pending', 'submitted', 'partially_filled')
        ORDER BY created_at DESC
        LIMIT 50
      `)
      const isSqlite = this.database.connection().dialect.name === 'better-sqlite3'
      const trades = isSqlite ? rows : rows[0]

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
          status: row.status as FastOrderState['status'],
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
        const orderId = Number(row.external_order_id)
        this.orders.set(clientOrderId, state)
        this.orderIdMap.set(orderId, clientOrderId)
      }

      logger.info('[IBKRFast] Recovered %d active orders from DB', trades.length)
      await this.reconcileWithExchange()
    } catch (err) {
      logger.error('[IBKRFast] DB recovery failed: %s', (err as Error).message)
    }
  }

  /** Refresh recovered order states from TWS/Gateway (openOrders snapshot). */
  private async reconcileWithExchange(): Promise<void> {
    try {
      const openOrders = await this.ibkr.getOpenOrders()
      for (const o of openOrders) {
        const clientOrderId = this.orderIdMap.get(o.orderId)
        const state = clientOrderId ? this.orders.get(clientOrderId) : undefined
        if (!state) continue
        const newStatus = IB_STATUS_MAP[o.status]
        if (newStatus && state.status !== newStatus) {
          state.status = newStatus
          state.dirty = true
        }
        if (Number(o.filledQuantity || 0) > 0) state.filledQuantity = Number(o.filledQuantity)
        if (o.avgFillPrice && Number(o.avgFillPrice) > 0) state.fillPrice = Number(o.avgFillPrice)
        this.enqueueFlush(state)
      }
    } catch (err) {
      logger.warn('[IBKRFast] Exchange reconcile failed: %s', (err as Error).message)
    }
  }
}

export default new IBKRFastEngine()