import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Trade from 'App/Models/Trade'
import Ticker from 'App/Models/Ticker'
import IBKRService from 'App/Services/IBKRService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'
import Database from '@ioc:Adonis/Lucid/Database'

export default class TradingController {
  /**
   * IB connection status + account overview
   */
  public async status({ response }: HttpContextContract) {
    const connectionStatus = IBKRService.getConnectionStatus()

    let account = {}
    let positions: any[] = []
    let openOrders: any[] = []

    if (connectionStatus.connected) {
      ;[account, positions, openOrders] = await Promise.all([
        IBKRService.getAccountSummary(),
        IBKRService.getPositions(),
        IBKRService.getOpenOrders(),
      ])
    }

    return response.json({
      connection: connectionStatus,
      account,
      positions,
      openOrders,
    })
  }

  /**
   * Connect to IB TWS/Gateway
   */
  public async connect({ response }: HttpContextContract) {
    const result = await IBKRService.connect()
    if (result) {
      return response.json({ connected: true, message: 'Connected to IB TWS/Gateway' })
    }
    return response.serviceUnavailable({
      connected: false,
      error: 'Failed to connect. Ensure TWS or IB Gateway is running.',
    })
  }

  /**
   * Disconnect from IB
   */
  public async disconnect({ response }: HttpContextContract) {
    IBKRService.disconnect()
    return response.json({ connected: false, message: 'Disconnected from IB' })
  }

  /**
   * Get account summary
   */
  public async account({ response }: HttpContextContract) {
    if (!IBKRService.isConnected) {
      return response.serviceUnavailable({ error: 'Not connected to IB' })
    }
    const summary = await IBKRService.getAccountSummary()
    return response.json(summary)
  }

  /**
   * Get portfolio positions from IB
   */
  public async positions({ response }: HttpContextContract) {
    if (!IBKRService.isConnected) {
      return response.serviceUnavailable({ error: 'Not connected to IB' })
    }
    const positions = await IBKRService.getPositions()
    return response.json(positions)
  }

  /**
   * Place a new order
   */
  public async placeOrder({ request, response }: HttpContextContract) {
    const symbol = request.input('symbol', '').toUpperCase()
    const side = request.input('side') as 'BUY' | 'SELL'
    const orderType = request.input('order_type', 'MKT') as Trade['orderType']
    const quantity = Number(request.input('quantity'))
    const limitPrice = request.input('limit_price') ? Number(request.input('limit_price')) : null
    const stopPrice = request.input('stop_price') ? Number(request.input('stop_price')) : null
    const trailAmount = request.input('trail_amount') ? Number(request.input('trail_amount')) : null
    const timeInForce = request.input('time_in_force', 'DAY')
    const exchange = request.input('exchange', 'SMART')
    const currency = request.input('currency', 'USD')
    const analysisId = request.input('analysis_id') ? Number(request.input('analysis_id')) : null

    // Validation
    if (!symbol) return response.badRequest({ error: 'symbol is required' })
    if (!['BUY', 'SELL'].includes(side)) return response.badRequest({ error: 'side must be BUY or SELL' })
    if (!quantity || quantity <= 0) return response.badRequest({ error: 'quantity must be > 0' })
    if (!['MKT', 'LMT', 'STP', 'STP_LMT', 'TRAIL'].includes(orderType)) {
      return response.badRequest({ error: 'Invalid order_type' })
    }
    if (['LMT', 'STP_LMT'].includes(orderType) && !limitPrice) {
      return response.badRequest({ error: 'limit_price required for LMT/STP_LMT orders' })
    }
    if (['STP', 'STP_LMT'].includes(orderType) && !stopPrice) {
      return response.badRequest({ error: 'stop_price required for STP/STP_LMT orders' })
    }

    // Find or reference the ticker
    let ticker = await Ticker.findBy('symbol', symbol)
    if (!ticker) {
      // Create a minimal ticker record
      ticker = await Ticker.create({ symbol, name: symbol, isActive: true })
    }

    const trade = await Trade.create({
      tickerId: ticker.id,
      symbol,
      side,
      orderType,
      quantity,
      limitPrice,
      stopPrice,
      trailAmount,
      timeInForce,
      exchange,
      currency,
      analysisId,
      status: 'pending',
      filledQuantity: 0,
    })

    // Submit order via BullMQ
    await QueueService.addJob(QUEUE_NAMES.SUBMIT_ORDER, { tradeId: trade.id })

    return response.created({
      trade: trade.serialize(),
      message: 'Order queued for submission',
    })
  }

  /**
   * Cancel an active order
   */
  public async cancelOrder({ params, response }: HttpContextContract) {
    const trade = await Trade.findOrFail(params.id)

    if (['filled', 'cancelled', 'error'].includes(trade.status)) {
      return response.badRequest({ error: `Cannot cancel order in ${trade.status} status` })
    }

    const updated = await IBKRService.cancelOrder(trade)
    return response.json({ trade: updated.serialize(), message: 'Cancel requested' })
  }

  /**
   * List all trades with filters
   */
  public async index({ request, response }: HttpContextContract) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 30)
    const symbol = request.input('symbol')
    const status = request.input('status')
    const side = request.input('side')

    const query = Trade.query()
      .preload('ticker')
      .preload('analysis')
      .orderBy('created_at', 'desc')

    if (symbol) query.where('symbol', symbol.toUpperCase())
    if (status) query.where('status', status)
    if (side) query.where('side', side.toUpperCase())

    const trades = await query.paginate(page, limit)
    return response.json(trades)
  }

  /**
   * Get single trade details
   */
  public async show({ params, response }: HttpContextContract) {
    const trade = await Trade.query()
      .where('id', params.id)
      .preload('ticker')
      .preload('analysis', (q) => q.preload('article'))
      .firstOrFail()

    return response.json(trade.serialize())
  }

  /**
   * Trade stats and P&L summary
   */
  public async stats({ request, response }: HttpContextContract) {
    const symbol = request.input('symbol')

    const whereClause = symbol ? `WHERE t.symbol = '${symbol.toUpperCase()}'` : ''

    const [overview, bySymbol, byStatus, recentFills] = await Promise.all([
      Database.rawQuery(`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) as buy_count,
          SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) as sell_count,
          SUM(CASE WHEN status = 'filled' THEN filled_quantity * fill_price ELSE 0 END) as total_volume,
          SUM(COALESCE(commission, 0)) as total_commission,
          SUM(COALESCE(realized_pnl, 0)) as total_realized_pnl
        FROM trades t
        ${whereClause}
      `),
      Database.rawQuery(`
        SELECT
          t.symbol,
          COUNT(*) as trade_count,
          SUM(CASE WHEN side = 'BUY' THEN filled_quantity ELSE 0 END) as total_bought,
          SUM(CASE WHEN side = 'SELL' THEN filled_quantity ELSE 0 END) as total_sold,
          SUM(COALESCE(realized_pnl, 0)) as pnl,
          SUM(COALESCE(commission, 0)) as commission
        FROM trades t
        WHERE status = 'filled'
        GROUP BY t.symbol
        ORDER BY trade_count DESC
        LIMIT 20
      `),
      Database.rawQuery(`
        SELECT status, COUNT(*) as count
        FROM trades t
        ${whereClause}
        GROUP BY status
      `),
      Trade.query()
        .where('status', 'filled')
        .preload('ticker')
        .orderBy('filled_at', 'desc')
        .limit(10),
    ])

    return response.json({
      overview: overview[0][0],
      bySymbol: bySymbol[0],
      byStatus: byStatus[0],
      recentFills: recentFills.map((t) => t.serialize()),
    })
  }
}
