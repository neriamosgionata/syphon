import type { HttpContext } from '@adonisjs/core/http'
import FastTradeEngine from '#services/FastTradeEngine'
import BinanceWS from '#services/BinanceWebSocketService'

export default class FastTradingController {
  /**
   * Start the fast trading engine
   */
  public async start({ request, response }: HttpContext) {
    if (FastTradeEngine.running) {
      return response.json({ running: true, message: 'Already running' })
    }

    const symbols = request.input('symbols', 'BTC,ETH,SOL')
      .split(',')
      .map((s: string) => s.trim().toUpperCase().replace(/USDT$/, ''))

    await FastTradeEngine.start(symbols)
    return response.json({
      running: FastTradeEngine.running,
      symbols: BinanceWS.getConnectedSymbols(),
      message: 'Fast trading engine started',
    })
  }

  /**
   * Stop the fast trading engine
   */
  public async stop({ response }: HttpContext) {
    await FastTradeEngine.stop()
    return response.json({ running: false, message: 'Fast trading engine stopped' })
  }

  /**
   * Place a fast order (bypasses BullMQ, direct to Binance)
   */
  public async placeOrder({ request, response }: HttpContext) {
    const symbol = request.input('symbol', '').toUpperCase()
    const side = request.input('side') as 'BUY' | 'SELL'
    const quantity = Number(request.input('quantity'))
    const orderType = request.input('order_type', 'MARKET')
    const price = request.input('price') ? Number(request.input('price')) : undefined
    const stopPrice = request.input('stop_price') ? Number(request.input('stop_price')) : undefined

    if (!symbol) return response.badRequest({ error: 'symbol required' })
    if (!['BUY', 'SELL'].includes(side)) return response.badRequest({ error: 'side must be BUY or SELL' })
    if (!quantity || quantity <= 0) return response.badRequest({ error: 'quantity must be > 0' })
    const validOrderTypes = ['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TRAILING_STOP_MARKET']
    if (!validOrderTypes.includes(orderType.toUpperCase())) {
      return response.badRequest({ error: `order_type must be one of: ${validOrderTypes.join(', ')}` })
    }

    if (!FastTradeEngine.running) {
      return response.serviceUnavailable({ error: 'Fast engine not running. POST /api/fast/start first' })
    }

    const startTime = Date.now()
    const order = await FastTradeEngine.placeOrder({ symbol, side, quantity, orderType, price, stopPrice })
    const elapsed = Date.now() - startTime

    if (order.status === 'error') {
      return response.badRequest({
        error: order.errorMessage || 'Order failed',
        elapsedMs: elapsed,
      })
    }

    return response.json({
      order,
      elapsedMs: elapsed,
      message: `Order ${order.status} in ${elapsed}ms`,
    })
  }

  /**
   * Cancel an order
   */
  public async cancelOrder({ params, response }: HttpContext) {
    const { clientOrderId } = params
    const ok = await FastTradeEngine.cancelOrder(clientOrderId)
    if (ok) {
      return response.json({ cancelled: true, clientOrderId })
    }
    return response.badRequest({ error: 'Cancel failed or order not found', clientOrderId })
  }

  /**
   * List all in-memory orders
   */
  public async index({ request, response }: HttpContext) {
    const symbol = request.input('symbol')
    const activeOnly = request.input('active') === 'true'

    let orders = symbol
      ? FastTradeEngine.getOrdersBySymbol(symbol)
      : FastTradeEngine.getAllOrders()

    if (activeOnly) {
      orders = orders.filter((o) => ['pending', 'submitted', 'partially_filled'].includes(o.status))
    }

    return response.json({
      count: orders.length,
      orders: orders.sort((a, b) => b.submittedAt - a.submittedAt),
    })
  }

  /**
   * Get single order by clientOrderId
   */
  public async show({ params, response }: HttpContext) {
    const order = FastTradeEngine.getOrder(params.clientOrderId)
    if (!order) {
      return response.notFound({ error: 'Order not found' })
    }
    return response.json(order)
  }

  /**
   * Get latest price from WebSocket cache
   */
  public async price({ params, response }: HttpContext) {
    const symbol = params.symbol.toUpperCase()
    const price = BinanceWS.getPrice(symbol)
    if (price === null) {
      return response.json({ symbol, price: null, source: 'cache', stale: true })
    }
    return response.json({ symbol, price, source: 'ws_live' })
  }

  /**
   * Get engine status
   */
  public async status({ response }: HttpContext) {
    const active = FastTradeEngine.getActiveOrders()
    const all = FastTradeEngine.getAllOrders()
    const symbols = BinanceWS.getConnectedSymbols()

    const prices: Record<string, number | null> = {}
    for (const s of symbols) {
      prices[s] = BinanceWS.getPrice(s)
    }

    return response.json({
      running: FastTradeEngine.running,
      activeOrders: active.length,
      totalOrders: all.length,
      subscribedSymbols: symbols,
      prices,
      wsConnected: BinanceWS.getConnectedSymbols().length > 0,
    })
  }

  /**
   * Add symbols to WebSocket subscription
   */
  public async subscribe({ request, response }: HttpContext) {
    const symbols = request.input('symbols', '')
      .split(',')
      .map((s: string) => s.trim().toUpperCase().replace(/USDT$/, ''))
      .filter(Boolean)

    for (const s of symbols) {
      BinanceWS.addSymbol(s)
    }

    return response.json({
      subscribed: BinanceWS.getConnectedSymbols(),
      message: `Added ${symbols.length} symbols`,
    })
  }
}
