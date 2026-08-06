import crypto from 'crypto'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'
import Trade from 'App/Models/Trade'
import { DateTime } from 'luxon'

const BINANCE_BASE = 'https://api.binance.com'

export interface BinanceOrderInfo {
  symbol: string
  orderId: number
  clientOrderId: string
  price: string
  origQty: string
  executedQty: string
  cummulativeQuoteQty: string
  status: string
  timeInForce: string
  type: string
  side: string
  stopPrice: string
  icebergQty: string
  time: number
  updateTime: number
  isWorking: boolean
  origQuoteOrderQty: string
}

function getBinanceSignature(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

class BinanceService {
  private apiKey: string = ''
  private apiSecret: string = ''
  private _connected: boolean = false

  public get isConnected(): boolean {
    return this._connected
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  public async connect(): Promise<boolean> {
    this.apiKey = Env.get('BINANCE_API_KEY', '')
    this.apiSecret = Env.get('BINANCE_API_SECRET', '')

    if (!this.apiKey || !this.apiSecret) {
      Logger.warn('[Binance] API key/secret not configured')
      return false
    }

    try {
      await this.privateRequest('/api/v3/account')
      this._connected = true
      Logger.info('[Binance] Connected successfully')
      return true
    } catch (error) {
      Logger.error('[Binance] Connection failed: %s', error.message)
      this._connected = false
      return false
    }
  }

  public disconnect() {
    this._connected = false
    Logger.info('[Binance] Disconnected')
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async publicRequest(path: string, params: Record<string, any> = {}): Promise<any> {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    const res = await fetch(`${BINANCE_BASE}${path}${qs}`)
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 200)}`) }
    if (json.code && json.msg) throw new Error(json.msg)
    return json
  }

  private async privateRequest(path: string, params: Record<string, any> = {}, method: string = 'GET'): Promise<any> {
    const timestamp = Date.now()
    const allParams = { ...params, timestamp }
    const queryString = new URLSearchParams(allParams as any).toString()
    const signature = getBinanceSignature(queryString, this.apiSecret)
    const signedQs = `${queryString}&signature=${signature}`

    const url = `${BINANCE_BASE}${path}?${signedQs}`

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

  // ---------------------------------------------------------------------------
  // Account Data
  // ---------------------------------------------------------------------------

  public async getAccountInfo(): Promise<any> {
    return this.privateRequest('/api/v3/account')
  }

  public async getBalance(): Promise<Record<string, string>> {
    const account = await this.privateRequest('/api/v3/account')
    const balances: Record<string, string> = {}
    for (const b of account.balances || []) {
      const free = parseFloat(b.free)
      const locked = parseFloat(b.locked)
      if (free > 0 || locked > 0) {
        balances[b.asset] = b.free
      }
    }
    return balances
  }

  /**
   * Total portfolio value in USDT across all assets (stablecoins at 1:1,
   * other assets priced via USDT pairs, falling back to BTC pairs). The old
   * USDT-only count undervalued portfolios holding other coins, which skewed
   * algo exposure sizing.
   */
  public async getTotalUsdtValue(): Promise<number> {
    const account = await this.privateRequest('/api/v3/account')
    const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'USDP'])

    let total = 0
    const toValue: { asset: string; amount: number }[] = []

    for (const b of account.balances || []) {
      const amount = parseFloat(b.free || '0') + parseFloat(b.locked || '0')
      if (amount <= 0) continue
      if (STABLECOINS.has(b.asset)) {
        total += amount
      } else {
        toValue.push({ asset: b.asset, amount })
      }
    }

    for (const { asset, amount } of toValue) {
      try {
        const quote = await this.getTicker(`${asset}USDT`)
        total += amount * parseFloat(quote.price)
      } catch {
        try {
          const btcUsd = await this.getTicker('BTCUSDT')
          const assetBtc = await this.getTicker(`${asset}BTC`)
          total += amount * parseFloat(assetBtc.price) * parseFloat(btcUsd.price)
        } catch {
          Logger.debug('[Binance] Could not price %s — skipped in portfolio value', asset)
        }
      }
    }

    return total
  }

  public async getOpenOrders(symbol?: string): Promise<BinanceOrderInfo[]> {
    const params: Record<string, any> = {}
    if (symbol) params.symbol = symbol
    return this.privateRequest('/api/v3/openOrders', params)
  }

  public async queryOrder(symbol: string, orderId: number): Promise<BinanceOrderInfo> {
    return this.privateRequest('/api/v3/order', { symbol, orderId })
  }

  public async getTicker(symbol: string): Promise<any> {
    return this.publicRequest('/api/v3/ticker/price', { symbol })
  }

  // ---------------------------------------------------------------------------
  // Order Placement
  // ---------------------------------------------------------------------------

  public buildPair(symbol: string, currency: string = 'USDT'): string {
    return `${symbol.toUpperCase()}${currency.toUpperCase()}`
  }

  public async placeOrder(trade: Trade): Promise<Trade> {
    try {
      const symbol = this.buildPair(trade.symbol, trade.currency)

      const orderTypeMap: Record<string, string> = {
        MKT: 'MARKET',
        LMT: 'LIMIT',
        STP: 'STOP_LOSS',
        STP_LMT: 'STOP_LOSS_LIMIT',
        TRAIL: 'TRAILING_STOP_MARKET',
      }

      const params: Record<string, any> = {
        symbol,
        side: trade.side,
        type: orderTypeMap[trade.orderType] || 'MARKET',
        quantity: trade.quantity,
      }

      if (['LIMIT', 'STOP_LOSS_LIMIT'].includes(params.type) && trade.limitPrice) {
        params.price = String(trade.limitPrice)
        params.timeInForce = trade.timeInForce || 'GTC'
      }

      if (['STOP_LOSS', 'STOP_LOSS_LIMIT'].includes(params.type) && trade.stopPrice) {
        params.stopPrice = String(trade.stopPrice)
      }

      if (params.type === 'TRAILING_STOP_MARKET' && trade.trailAmount) {
        params.callbackRate = String(trade.trailAmount)
      }

      const result = await this.privateRequest('/api/v3/order', params, 'POST')

      trade.externalOrderId = String(result.orderId)
      trade.status = 'submitted'
      trade.submittedAt = DateTime.now()
      await trade.save()

      Logger.info(
        '[Binance] Placed order: %s %s %s %s (orderId=%s)',
        trade.side,
        trade.quantity,
        trade.symbol,
        trade.orderType,
        result.orderId,
      )

      return trade
    } catch (error) {
      trade.status = 'error'
      trade.errorMessage = error.message
      await trade.save()
      Logger.error('[Binance] Failed to place order: %s', error.message)
      return trade
    }
  }

  public async cancelOrder(trade: Trade): Promise<Trade> {
    try {
      const symbol = this.buildPair(trade.symbol, trade.currency)
      const orderId = trade.externalOrderId

      if (!orderId) {
        trade.status = 'cancelled'
        trade.cancelledAt = DateTime.now()
        await trade.save()
        return trade
      }

      await this.privateRequest('/api/v3/order', {
        symbol,
        orderId: Number(orderId),
      }, 'DELETE')

      trade.status = 'cancelled'
      trade.cancelledAt = DateTime.now()
      await trade.save()
      Logger.info('[Binance] Cancelled order %s', orderId)

      return trade
    } catch (error) {
      trade.errorMessage = error.message
      await trade.save()
      Logger.error('[Binance] Failed to cancel order: %s', error.message)
      return trade
    }
  }

  /**
   * Poll order status from Binance and update the trade record.
   */
  public async syncOrderStatus(trade: Trade): Promise<Trade> {
    const orderId = trade.externalOrderId
    if (!orderId) return trade

    try {
      const symbol = this.buildPair(trade.symbol, trade.currency)
      const order = await this.queryOrder(symbol, Number(orderId))
      if (!order) return trade

      const statusMap: Record<string, Trade['status']> = {
        NEW: 'submitted',
        PARTIALLY_FILLED: 'partially_filled',
        FILLED: 'filled',
        CANCELED: 'cancelled',
        REJECTED: 'error',
        EXPIRED: 'cancelled',
      }

      const newStatus = statusMap[order.status]
      if (newStatus) trade.status = newStatus

      const volExec = parseFloat(order.executedQty || '0')
      trade.filledQuantity = volExec

      const quoteQty = parseFloat(order.cummulativeQuoteQty || '0')
      if (volExec > 0 && quoteQty > 0) {
        trade.fillPrice = quoteQty / volExec
      }

      // Binance order queries don't include fees; pull them from the fills
      if (volExec > 0) {
        try {
          const fills = await this.privateRequest('/api/v3/myTrades', { symbol, orderId: Number(orderId) })
          let commission = 0
          for (const f of fills || []) {
            commission += parseFloat(f.commission || '0')
          }
          if (commission > 0) trade.commission = commission
        } catch (err) {
          Logger.debug('[Binance] Commission sync failed for order %s: %s', orderId, err.message)
        }
      }

      if (newStatus === 'filled') {
        trade.filledAt = DateTime.now()
      } else if (newStatus === 'cancelled') {
        trade.cancelledAt = DateTime.now()
      }

      await trade.save()
      return trade
    } catch (error) {
      Logger.error('[Binance] Failed to sync order %s: %s', orderId, error.message)
      return trade
    }
  }

  // ---------------------------------------------------------------------------
  // Unified helpers
  // ---------------------------------------------------------------------------

  public getConnectionStatus() {
    return {
      connected: this._connected,
      broker: 'binance' as const,
    }
  }
}

export default new BinanceService()
