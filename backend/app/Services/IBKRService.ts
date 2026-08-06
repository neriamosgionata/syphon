import {
  IBApi,
  EventName,
  Contract,
  Order,
  SecType,
  OrderAction,
  OrderType as IBOrderType,
  TimeInForce,
  OrderStatus,
} from '@stoqey/ib'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'
import Trade from 'App/Models/Trade'
import type { TradeSide, OrderType } from 'App/Models/Trade'
import { DateTime } from 'luxon'

interface IBKRPosition {
  account: string
  symbol: string
  secType: string
  exchange: string
  position: number
  avgCost: number
  marketValue?: number
}

interface IBKRAccountSummary {
  [key: string]: { value: string; currency: string }
}

class IBKRService {
  private ib: IBApi | null = null
  private connected: boolean = false
  private nextOrderId: number = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs = 30000
  private orderIdPromise: Promise<void> | null = null
  private resolveOrderIdPromise: (() => void) | null = null

  public get isConnected(): boolean {
    return this.connected
  }

  public async connect(): Promise<boolean> {
    if (this.connected && this.ib) return true

    const host = Env.get('IB_HOST', '127.0.0.1')
    const port = Number(Env.get('IB_PORT', '7497'))
    const clientId = Number(Env.get('IB_CLIENT_ID', '1'))

    return new Promise((resolve) => {
      try {
        this.ib = new IBApi({ host, port, clientId })
        this.setupEventHandlers()
        this.ib.connect()

        const timeout = setTimeout(() => {
          if (!this.connected) {
            Logger.warn('[IBKR] Connection timeout after 10s')
            resolve(false)
          }
        }, 10000)

        this.ib.once(EventName.connected, () => {
          clearTimeout(timeout)
          this.connected = true
          Logger.info('[IBKR] Connected to TWS/Gateway at %s:%d (clientId=%d)', host, port, clientId)
          this.ib!.reqIds()
          resolve(true)
        })
      } catch (error) {
        Logger.error('[IBKR] Connection error: %s', error.message)
        resolve(false)
      }
    })
  }

  public disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.resolveOrderIdPromise) {
      this.resolveOrderIdPromise()
      this.resolveOrderIdPromise = null
      this.orderIdPromise = null
    }
    if (this.ib) {
      this.ib.disconnect()
      this.ib = null
      this.connected = false
      Logger.info('[IBKR] Disconnected')
    }
  }

  /**
   * Auto-reconnect loop with exponential backoff. The old single-shot retry
   * stopped permanently after one failed attempt if TWS/Gateway was still
   * down.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      const ok = await this.connect()
      if (ok) {
        this.reconnectDelayMs = 30000
      } else if (!this.connected) {
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 300000)
        Logger.warn('[IBKR] Reconnect failed, retrying in %ds', this.reconnectDelayMs / 1000)
        this.scheduleReconnect()
      }
    }, this.reconnectDelayMs)
  }

  private setupEventHandlers() {
    if (!this.ib) return

    this.ib.on(EventName.disconnected, () => {
      this.connected = false
      Logger.warn('[IBKR] Disconnected from TWS/Gateway')
      this.scheduleReconnect()
    })

    this.ib.on(EventName.error, (err: Error, code: number, reqId: number) => {
      // code 2104/2106/2158 are informational messages, not errors
      if ([2104, 2106, 2158].includes(code)) {
        Logger.debug('[IBKR] Info %d: %s', code, err.message)
        return
      }
      Logger.error('[IBKR] Error %d (reqId=%d): %s', code, reqId, err.message)
    })

    this.ib.on(EventName.nextValidId, (orderId: number) => {
      this.nextOrderId = orderId
      if (this.resolveOrderIdPromise) {
        this.resolveOrderIdPromise()
        this.resolveOrderIdPromise = null
        this.orderIdPromise = null
      }
      Logger.debug('[IBKR] Next valid order ID: %d', orderId)
    })

    // Order status updates
    this.ib.on(
      EventName.orderStatus,
      (
        orderId: number,
        status: string,
        filled: number,
        remaining: number,
        avgFillPrice: number,
        permId: number,
        _parentId: number,
        _lastFillPrice: number,
        _clientId: number,
        _whyHeld: string,
      ) => {
        this.handleOrderStatus(orderId, status, filled, remaining, avgFillPrice, String(permId))
      },
    )

    // Execution details (fills)
    this.ib.on(EventName.execDetails, (_reqId: number, contract: Contract, execution: any) => {
      Logger.info(
        '[IBKR] Execution: %s %s %d @ %s (orderId=%d)',
        execution.side,
        contract.symbol,
        execution.shares,
        execution.price,
        execution.orderId,
      )
    })

    // Commission reports
    this.ib.on(EventName.commissionReport, (report: any) => {
      this.handleCommissionReport(report)
    })
  }

  private async handleOrderStatus(
    orderId: number,
    ibStatus: string,
    filled: number,
    _remaining: number,
    avgFillPrice: number,
    permId: string,
  ) {
    const statusMap: Record<string, Trade['status']> = {
      PreSubmitted: 'pre_submitted',
      Submitted: 'submitted',
      Filled: 'filled',
      Cancelled: 'cancelled',
      Inactive: 'inactive',
      ApiCancelled: 'cancelled',
    }

    const trade = await Trade.findBy('ib_order_id', orderId)
    if (!trade) return

    const newStatus = statusMap[ibStatus]
    if (!newStatus) return

    trade.status = newStatus
    trade.filledQuantity = filled
    trade.ibPermId = permId

    if (avgFillPrice > 0) {
      trade.fillPrice = avgFillPrice
    }

    if (newStatus === 'filled') {
      trade.filledAt = DateTime.now()
    } else if (newStatus === 'cancelled') {
      trade.cancelledAt = DateTime.now()
    }

    await trade.save()

    Logger.info(
      '[IBKR] Order %d status -> %s (filled=%d, avgPrice=%s)',
      orderId,
      newStatus,
      filled,
      avgFillPrice,
    )
  }

  private async handleCommissionReport(report: any) {
    if (!report.execId) return

    // Try to find trade by permId from the commission report
    const trade = await Trade.findBy('ib_perm_id', String(report.permId))
    if (trade) {
      trade.commission = report.commission
      trade.realizedPnl = report.realizedPNL !== Number.MAX_VALUE ? report.realizedPNL : null
      await trade.save()
    }
  }

  private getNextOrderId(): number {
    return this.nextOrderId++
  }

  /**
   * IB assigns order IDs asynchronously via nextValidId after connecting.
   * Placing an order before it arrives would use orderId 0, which TWS rejects
   * and leaves the trade stuck in 'submitted'.
   */
  private async ensureOrderIdReady(): Promise<boolean> {
    if (this.nextOrderId > 0) return true

    if (!this.orderIdPromise) {
      this.orderIdPromise = new Promise((resolve) => {
        this.resolveOrderIdPromise = resolve
      })
      setTimeout(() => {
        if (this.resolveOrderIdPromise) {
          this.resolveOrderIdPromise()
          this.resolveOrderIdPromise = null
          this.orderIdPromise = null
        }
      }, 10000)
    }

    await this.orderIdPromise
    return this.nextOrderId > 0
  }

  private buildContract(symbol: string, exchange: string = 'SMART', currency: string = 'USD'): Contract {
    return {
      symbol,
      exchange,
      currency,
      secType: SecType.STK,
    }
  }

  private buildOrder(
    orderId: number,
    side: TradeSide,
    orderType: OrderType,
    quantity: number,
    opts: {
      limitPrice?: number | null
      stopPrice?: number | null
      trailAmount?: number | null
      timeInForce?: string
    } = {},
  ): Order {
    const ibOrderTypeMap: Record<OrderType, IBOrderType> = {
      MKT: IBOrderType.MKT,
      LMT: IBOrderType.LMT,
      STP: IBOrderType.STP,
      STP_LMT: IBOrderType.STP_LMT,
      TRAIL: IBOrderType.TRAIL,
    }

    const tifMap: Record<string, TimeInForce> = {
      DAY: TimeInForce.DAY,
      GTC: TimeInForce.GTC,
      IOC: TimeInForce.IOC,
      OPG: TimeInForce.OPG,
    }

    const order: Order = {
      orderId,
      action: side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: ibOrderTypeMap[orderType],
      totalQuantity: quantity,
      tif: tifMap[opts.timeInForce || 'DAY'] || TimeInForce.DAY,
      transmit: true,
    }

    if (opts.limitPrice != null && ['LMT', 'STP_LMT'].includes(orderType)) {
      order.lmtPrice = opts.limitPrice
    }

    if (opts.stopPrice != null && ['STP', 'STP_LMT'].includes(orderType)) {
      order.auxPrice = opts.stopPrice
    }

    if (opts.trailAmount != null && orderType === 'TRAIL') {
      order.auxPrice = opts.trailAmount
    }

    return order
  }

  public async placeOrder(trade: Trade): Promise<Trade> {
    if (!this.ib || !this.connected) {
      const didConnect = await this.connect()
      if (!didConnect) {
        trade.status = 'error'
        trade.errorMessage = 'Unable to connect to IB TWS/Gateway'
        await trade.save()
        return trade
      }
    }

    const idReady = await this.ensureOrderIdReady()
    if (!idReady) {
      trade.status = 'error'
      trade.errorMessage = 'No valid order ID from TWS/Gateway (nextValidId not received)'
      await trade.save()
      return trade
    }

    const orderId = this.getNextOrderId()
    const contract = this.buildContract(trade.symbol, trade.exchange, trade.currency)
    const order = this.buildOrder(orderId, trade.side, trade.orderType, trade.quantity, {
      limitPrice: trade.limitPrice,
      stopPrice: trade.stopPrice,
      trailAmount: trade.trailAmount,
      timeInForce: trade.timeInForce,
    })

    trade.ibOrderId = orderId
    trade.status = 'submitted'
    trade.submittedAt = DateTime.now()
    await trade.save()

    try {
      this.ib!.placeOrder(orderId, contract, order)
      Logger.info(
        '[IBKR] Placed order %d: %s %d %s @ %s (%s)',
        orderId,
        trade.side,
        trade.quantity,
        trade.symbol,
        trade.orderType,
        trade.limitPrice || 'MKT',
      )
    } catch (error) {
      trade.status = 'error'
      trade.errorMessage = error.message
      await trade.save()
      Logger.error('[IBKR] Failed to place order: %s', error.message)
    }

    return trade
  }

  public async cancelOrder(trade: Trade): Promise<Trade> {
    if (!this.ib || !this.connected) {
      trade.errorMessage = 'Not connected to IB'
      await trade.save()
      return trade
    }

    if (!trade.ibOrderId) {
      trade.status = 'cancelled'
      trade.cancelledAt = DateTime.now()
      await trade.save()
      return trade
    }

    try {
      this.ib.cancelOrder(trade.ibOrderId)
      Logger.info('[IBKR] Cancel requested for order %d', trade.ibOrderId)
    } catch (error) {
      Logger.error('[IBKR] Failed to cancel order %d: %s', trade.ibOrderId, error.message)
      trade.errorMessage = error.message
      await trade.save()
    }

    return trade
  }

  public async getPositions(): Promise<IBKRPosition[]> {
    if (!this.ib || !this.connected) {
      const didConnect = await this.connect()
      if (!didConnect) return []
    }

    return new Promise((resolve) => {
      // Local state: concurrent calls (e.g. TradingController.status firing
      // positions + account in parallel) must not clobber each other's data.
      const positions: IBKRPosition[] = []

      const onPosition = (account: string, contract: Contract, pos: number, avgCost: number) => {
        if (pos !== 0) {
          positions.push({
            account,
            symbol: contract.symbol || '',
            secType: contract.secType || '',
            exchange: contract.exchange || '',
            position: pos,
            avgCost,
          })
        }
      }

      const onEnd = () => {
        this.ib!.off(EventName.position, onPosition)
        resolve(positions)
      }

      this.ib!.on(EventName.position, onPosition)
      this.ib!.once(EventName.positionEnd, onEnd)
      this.ib!.reqPositions()

      // Timeout fallback
      setTimeout(() => {
        this.ib!.off(EventName.position, onPosition)
        this.ib!.off(EventName.positionEnd, onEnd)
        resolve(positions)
      }, 10000)
    })
  }

  public async getAccountSummary(): Promise<IBKRAccountSummary> {
    if (!this.ib || !this.connected) {
      const didConnect = await this.connect()
      if (!didConnect) return {}
    }

    return new Promise((resolve) => {
      const summary: IBKRAccountSummary = {}
      const reqId = 9001

      const onSummary = (
        _reqId: number,
        account: string,
        tag: string,
        value: string,
        currency: string,
      ) => {
        summary[tag] = { value, currency }
      }

      const onEnd = () => {
        this.ib!.off(EventName.accountSummary, onSummary)
        resolve(summary)
      }

      this.ib!.on(EventName.accountSummary, onSummary)
      this.ib!.once(EventName.accountSummaryEnd, onEnd)

      this.ib!.reqAccountSummary(
        reqId,
        'All',
        'NetLiquidation,TotalCashValue,BuyingPower,GrossPositionValue,UnrealizedPnL,RealizedPnL,AvailableFunds',
      )

      setTimeout(() => {
        this.ib!.off(EventName.accountSummary, onSummary)
        this.ib!.off(EventName.accountSummaryEnd, onEnd)
        this.ib!.cancelAccountSummary(reqId)
        resolve(summary)
      }, 10000)
    })
  }

  public async getOpenOrders(): Promise<any[]> {
    if (!this.ib || !this.connected) {
      const didConnect = await this.connect()
      if (!didConnect) return []
    }

    return new Promise((resolve) => {
      const orders: any[] = []

      const onOpenOrder = (orderId: number, contract: Contract, order: Order, orderState: any) => {
        orders.push({
          orderId,
          symbol: contract.symbol,
          action: order.action,
          orderType: order.orderType,
          totalQuantity: order.totalQuantity,
          lmtPrice: order.lmtPrice,
          auxPrice: order.auxPrice,
          status: orderState.status,
          commission: orderState.commission,
        })
      }

      const onEnd = () => {
        this.ib!.off(EventName.openOrder, onOpenOrder)
        resolve(orders)
      }

      this.ib!.on(EventName.openOrder, onOpenOrder)
      this.ib!.once(EventName.openOrderEnd, onEnd)
      this.ib!.reqOpenOrders()

      setTimeout(() => {
        this.ib!.off(EventName.openOrder, onOpenOrder)
        this.ib!.off(EventName.openOrderEnd, onEnd)
        resolve(orders)
      }, 10000)
    })
  }

  public getConnectionStatus() {
    return {
      connected: this.connected,
      host: Env.get('IB_HOST', '127.0.0.1'),
      port: Number(Env.get('IB_PORT', '7497')),
      clientId: Number(Env.get('IB_CLIENT_ID', '1')),
      nextOrderId: this.nextOrderId,
    }
  }
}

export default new IBKRService()
