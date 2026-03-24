import crypto from 'crypto'
import querystring from 'querystring'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'
import Trade from 'App/Models/Trade'
import { DateTime } from 'luxon'

const KRAKEN_BASE = 'https://api.kraken.com'
const KRAKEN_FUTURES_BASE = 'https://futures.kraken.com'

// Kraken uses XBT instead of BTC
const PAIR_ALIASES: Record<string, string> = {
  BTC: 'XBT',
}

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

/**
 * Generate Kraken Futures Authent header.
 * HMAC-SHA512 of (SHA256(postData + nonce + path)), keyed with base64-decoded secret.
 */
function getFuturesSignature(path: string, postData: string, nonce: string, secret: string): string {
  const hashDigest = crypto.createHash('sha256').update(postData + nonce + path).digest()
  const secretBuffer = Buffer.from(secret, 'base64')
  return crypto.createHmac('sha512', secretBuffer).update(hashDigest).digest('base64')
}

export interface KrakenOrderInfo {
  status: string // pending, open, closed, canceled, expired
  opentm: number
  closetm: number
  descr: { pair: string; type: string; ordertype: string; price: string; order: string }
  vol: string
  vol_exec: string
  cost: string
  fee: string
  price: string
  misc: string
  oflags: string
}

class KrakenService {
  private apiKey: string = ''
  private apiSecret: string = ''
  private futuresKey: string = ''
  private futuresSecret: string = ''
  private _connected: boolean = false

  public get isConnected(): boolean {
    return this._connected
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  public async connect(): Promise<boolean> {
    this.apiKey = Env.get('KRAKEN_API_KEY', '')
    this.apiSecret = Env.get('KRAKEN_API_SECRET', '')
    this.futuresKey = Env.get('KRAKEN_FUTURES_KEY', '') || this.apiKey
    this.futuresSecret = Env.get('KRAKEN_FUTURES_SECRET', '') || this.apiSecret

    if (!this.apiKey || !this.apiSecret) {
      Logger.warn('[Kraken] API key/secret not configured')
      return false
    }

    try {
      // Validate by fetching balance
      await this.privateRequest('/0/private/Balance', {})
      this._connected = true
      Logger.info('[Kraken] Connected successfully')
      return true
    } catch (error) {
      Logger.error('[Kraken] Connection failed: %s', error.message)
      this._connected = false
      return false
    }
  }

  public disconnect() {
    this._connected = false
    Logger.info('[Kraken] Disconnected')
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async publicRequest(path: string, params: Record<string, any> = {}): Promise<any> {
    const qs = Object.keys(params).length ? '?' + querystring.stringify(params) : ''
    const res = await fetch(`${KRAKEN_BASE}${path}${qs}`)
    const json = await res.json()
    if (json.error && json.error.length > 0) {
      throw new Error(json.error.join('; '))
    }
    return json.result
  }

  private async privateRequest(path: string, params: Record<string, any> = {}): Promise<any> {
    const nonce = Date.now() * 1000 // microsecond-precision nonce
    const body = { nonce, ...params }
    const signature = getKrakenSignature(path, body, this.apiSecret)

    const res = await fetch(`${KRAKEN_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': this.apiKey,
        'API-Sign': signature,
      },
      body: querystring.stringify(body),
    })

    const json = await res.json()
    if (json.error && json.error.length > 0) {
      throw new Error(json.error.join('; '))
    }
    return json.result
  }

  private async futuresRequest(method: string, path: string, params: Record<string, any> = {}): Promise<any> {
    const postData = method === 'POST' ? querystring.stringify(params) : ''
    const nonce = Date.now().toString()
    const signature = getFuturesSignature(path, postData, nonce, this.futuresSecret)

    const url = method === 'GET' && Object.keys(params).length
      ? `${KRAKEN_FUTURES_BASE}${path}?${querystring.stringify(params)}`
      : `${KRAKEN_FUTURES_BASE}${path}`

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'APIKey': this.futuresKey,
        'Authent': signature,
        'Nonce': nonce,
      },
      ...(method === 'POST' && postData ? { body: postData } : {}),
    })

    const json = await res.json()
    if (json.result && json.result !== 'success' && json.error) {
      throw new Error(json.error)
    }
    return json
  }

  // ---------------------------------------------------------------------------
  // Spot + Margin: Account Data
  // ---------------------------------------------------------------------------

  public async getBalance(): Promise<Record<string, string>> {
    return this.privateRequest('/0/private/Balance')
  }

  public async getTradeBalance(asset: string = 'ZUSD'): Promise<Record<string, string>> {
    return this.privateRequest('/0/private/TradeBalance', { asset })
  }

  public async getOpenOrders(): Promise<Record<string, KrakenOrderInfo>> {
    const result = await this.privateRequest('/0/private/OpenOrders')
    return result?.open || {}
  }

  public async queryOrder(txid: string): Promise<Record<string, KrakenOrderInfo>> {
    return this.privateRequest('/0/private/QueryOrders', { txid })
  }

  public async getOpenPositions(): Promise<Record<string, any>> {
    return this.privateRequest('/0/private/OpenPositions')
  }

  public async getTicker(pair: string): Promise<any> {
    return this.publicRequest('/0/public/Ticker', { pair })
  }

  // ---------------------------------------------------------------------------
  // Spot + Margin: Order Placement
  // ---------------------------------------------------------------------------

  public buildPair(symbol: string, currency: string = 'USD'): string {
    const mapped = PAIR_ALIASES[symbol.toUpperCase()] || symbol.toUpperCase()
    return `${mapped}${currency.toUpperCase()}`
  }

  public async placeOrder(trade: Trade): Promise<Trade> {
    try {
      const pair = this.buildPair(trade.symbol, trade.currency)

      const orderTypeMap: Record<string, string> = {
        MKT: 'market',
        LMT: 'limit',
        STP: 'stop-loss',
        STP_LMT: 'stop-loss-limit',
        TRAIL: 'trailing-stop',
      }

      const params: Record<string, any> = {
        pair,
        type: trade.side.toLowerCase(),
        ordertype: orderTypeMap[trade.orderType] || 'market',
        volume: String(trade.quantity),
      }

      // Price params
      if (['LMT', 'STP_LMT'].includes(trade.orderType) && trade.limitPrice) {
        params.price = String(trade.limitPrice)
      }
      if (['STP', 'STP_LMT'].includes(trade.orderType) && trade.stopPrice) {
        if (trade.orderType === 'STP') {
          params.price = String(trade.stopPrice)
        } else {
          params.price = String(trade.stopPrice)
          params.price2 = String(trade.limitPrice)
        }
      }
      if (trade.orderType === 'TRAIL' && trade.trailAmount) {
        params.price = `+${trade.trailAmount}`
      }

      // Margin leverage (exchange field: e.g. "2x", "3x", "5x")
      const leverageMatch = trade.exchange.match(/^(\d+)x$/i)
      if (leverageMatch) {
        params.leverage = leverageMatch[1]
      }

      // Time in force
      if (['GTC', 'IOC'].includes(trade.timeInForce)) {
        params.timeinforce = trade.timeInForce
      }

      const result = await this.privateRequest('/0/private/AddOrder', params)

      const txid = result?.txid?.[0]
      trade.externalOrderId = txid || null
      trade.status = 'submitted'
      trade.submittedAt = DateTime.now()
      await trade.save()

      Logger.info(
        '[Kraken] Placed order: %s %s %s %s (txid=%s)',
        trade.side,
        trade.quantity,
        trade.symbol,
        trade.orderType,
        txid,
      )

      return trade
    } catch (error) {
      trade.status = 'error'
      trade.errorMessage = error.message
      await trade.save()
      Logger.error('[Kraken] Failed to place order: %s', error.message)
      return trade
    }
  }

  public async cancelOrder(trade: Trade): Promise<Trade> {
    try {
      const txid = trade.externalOrderId
      if (!txid) {
        trade.status = 'cancelled'
        trade.cancelledAt = DateTime.now()
        await trade.save()
        return trade
      }

      await this.privateRequest('/0/private/CancelOrder', { txid })
      trade.status = 'cancelled'
      trade.cancelledAt = DateTime.now()
      await trade.save()
      Logger.info('[Kraken] Cancelled order %s', txid)

      return trade
    } catch (error) {
      trade.errorMessage = error.message
      await trade.save()
      Logger.error('[Kraken] Failed to cancel order: %s', error.message)
      return trade
    }
  }

  /**
   * Poll order status from Kraken and update the trade record.
   */
  public async syncOrderStatus(trade: Trade): Promise<Trade> {
    const txid = trade.externalOrderId
    if (!txid) return trade

    try {
      const orders = await this.queryOrder(txid)
      const order = orders[txid]
      if (!order) return trade

      const statusMap: Record<string, Trade['status']> = {
        pending: 'pending',
        open: 'submitted',
        closed: 'filled',
        canceled: 'cancelled',
        expired: 'cancelled',
      }

      const newStatus = statusMap[order.status]
      if (newStatus) trade.status = newStatus

      const volExec = parseFloat(order.vol_exec || '0')
      trade.filledQuantity = Math.floor(volExec) || volExec

      if (order.price && parseFloat(order.price) > 0) {
        trade.fillPrice = parseFloat(order.price)
      }

      if (order.fee && parseFloat(order.fee) > 0) {
        trade.commission = parseFloat(order.fee)
      }

      if (newStatus === 'filled') {
        trade.filledAt = DateTime.now()
      } else if (newStatus === 'cancelled') {
        trade.cancelledAt = DateTime.now()
      }

      // Check partial fill
      const volTotal = parseFloat(order.vol || '0')
      if (volExec > 0 && volExec < volTotal && order.status === 'open') {
        trade.status = 'partially_filled'
      }

      await trade.save()
      return trade
    } catch (error) {
      Logger.error('[Kraken] Failed to sync order %s: %s', txid, error.message)
      return trade
    }
  }

  // ---------------------------------------------------------------------------
  // Futures
  // ---------------------------------------------------------------------------

  public async getFuturesAccounts(): Promise<any> {
    try {
      const result = await this.futuresRequest('GET', '/derivatives/api/v3/accounts')
      return result.accounts || result
    } catch (error) {
      Logger.error('[Kraken Futures] Failed to get accounts: %s', error.message)
      return {}
    }
  }

  public async getFuturesPositions(): Promise<any[]> {
    try {
      const result = await this.futuresRequest('GET', '/derivatives/api/v3/openpositions')
      return result.openPositions || []
    } catch (error) {
      Logger.error('[Kraken Futures] Failed to get positions: %s', error.message)
      return []
    }
  }

  public async getFuturesOpenOrders(): Promise<any[]> {
    try {
      const result = await this.futuresRequest('GET', '/derivatives/api/v3/openorders')
      return result.openOrders || []
    } catch (error) {
      Logger.error('[Kraken Futures] Failed to get open orders: %s', error.message)
      return []
    }
  }

  public async placeFuturesOrder(trade: Trade): Promise<Trade> {
    try {
      const orderTypeMap: Record<string, string> = {
        MKT: 'mkt',
        LMT: 'lmt',
        STP: 'stp',
        STP_LMT: 'stp',
        TRAIL: 'trailing_stop',
      }

      const params: Record<string, string> = {
        orderType: orderTypeMap[trade.orderType] || 'mkt',
        symbol: `PF_${trade.symbol.toUpperCase()}USD`,
        side: trade.side.toLowerCase(),
        size: String(trade.quantity),
      }

      if (trade.limitPrice && ['LMT', 'STP_LMT'].includes(trade.orderType)) {
        params.limitPrice = String(trade.limitPrice)
      }
      if (trade.stopPrice && ['STP', 'STP_LMT'].includes(trade.orderType)) {
        params.stopPrice = String(trade.stopPrice)
      }
      if (trade.trailAmount && trade.orderType === 'TRAIL') {
        params.trailingStopDeviationUnit = 'ABSOLUTE'
        params.trailingStopMaxDeviation = String(trade.trailAmount)
      }

      const result = await this.futuresRequest('POST', '/derivatives/api/v3/sendorder', params)

      if (result.result !== 'success') {
        trade.status = 'error'
        trade.errorMessage = result.error || 'Futures order failed'
        await trade.save()
        return trade
      }

      trade.externalOrderId = result.sendStatus?.order_id || null
      trade.status = 'submitted'
      trade.submittedAt = DateTime.now()
      await trade.save()

      Logger.info('[Kraken Futures] Placed order: %s (id=%s)', params.symbol, trade.externalOrderId)
      return trade
    } catch (error) {
      trade.status = 'error'
      trade.errorMessage = error.message
      await trade.save()
      Logger.error('[Kraken Futures] Failed to place order: %s', error.message)
      return trade
    }
  }

  public async cancelFuturesOrder(trade: Trade): Promise<Trade> {
    try {
      if (!trade.externalOrderId) {
        trade.status = 'cancelled'
        trade.cancelledAt = DateTime.now()
        await trade.save()
        return trade
      }

      const result = await this.futuresRequest('POST', '/derivatives/api/v3/cancelorder', {
        order_id: trade.externalOrderId,
      })

      if (result.result === 'success') {
        trade.status = 'cancelled'
        trade.cancelledAt = DateTime.now()
      } else {
        trade.errorMessage = result.error || 'Cancel failed'
      }
      await trade.save()
      return trade
    } catch (error) {
      trade.errorMessage = error.message
      await trade.save()
      return trade
    }
  }

  // ---------------------------------------------------------------------------
  // Unified helpers
  // ---------------------------------------------------------------------------

  public isFuturesTrade(trade: Trade): boolean {
    return trade.exchange.toLowerCase() === 'futures'
  }

  public async placeOrderAny(trade: Trade): Promise<Trade> {
    if (this.isFuturesTrade(trade)) {
      return this.placeFuturesOrder(trade)
    }
    return this.placeOrder(trade)
  }

  public async cancelOrderAny(trade: Trade): Promise<Trade> {
    if (this.isFuturesTrade(trade)) {
      return this.cancelFuturesOrder(trade)
    }
    return this.cancelOrder(trade)
  }

  public getConnectionStatus() {
    return {
      connected: this._connected,
      broker: 'kraken' as const,
    }
  }
}

export default new KrakenService()
