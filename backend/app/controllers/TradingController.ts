import type { HttpContext } from '@adonisjs/core/http'
import Trade from '#models/Trade'
import type { Broker } from '#models/Trade'
import Ticker from '#models/Ticker'
import IBKRService from '#services/IBKRService'
import KrakenService from '#services/KrakenService'
import QueueService, { QUEUE_NAMES } from '#jobs/QueueService'
import db from '@adonisjs/lucid/services/db'

export default class TradingController {
  /**
   * Combined connection status for all brokers
   */
  public async status({ response }: HttpContext) {
    const ibkrStatus = IBKRService.getConnectionStatus()
    const krakenStatus = KrakenService.getConnectionStatus()

    let ibkrAccount = {}
    let ibkrPositions: any[] = []
    let ibkrOpenOrders: any[] = []

    if (ibkrStatus.connected) {
      ;[ibkrAccount, ibkrPositions, ibkrOpenOrders] = await Promise.all([
        IBKRService.getAccountSummary(),
        IBKRService.getPositions(),
        IBKRService.getOpenOrders(),
      ])
    }

    let krakenBalance = {}
    let krakenTradeBalance = {}
    let krakenPositions: any = {}
    let krakenOpenOrders: any = {}

    if (krakenStatus.connected) {
      ;[krakenBalance, krakenTradeBalance, krakenPositions, krakenOpenOrders] = await Promise.all([
        KrakenService.getBalance().catch(() => ({})),
        KrakenService.getTradeBalance().catch(() => ({})),
        KrakenService.getOpenPositions().catch(() => ({})),
        KrakenService.getOpenOrders().catch(() => ({})),
      ])
    }

    return response.json({
      // Legacy field for backwards compat
      connection: ibkrStatus,
      account: ibkrAccount,
      positions: ibkrPositions,
      openOrders: ibkrOpenOrders,
      // Kraken-specific
      kraken: {
        connection: krakenStatus,
        balance: krakenBalance,
        tradeBalance: krakenTradeBalance,
        positions: krakenPositions,
        openOrders: krakenOpenOrders,
      },
    })
  }

  /**
   * Connect to a broker
   */
  public async connect({ request, response }: HttpContext) {
    const broker = (request.input('broker', 'ibkr') as string).toLowerCase()

    if (broker === 'kraken') {
      const result = await KrakenService.connect()
      if (result) {
        return response.json({ connected: true, broker: 'kraken', message: 'Connected to Kraken' })
      }
      return response.serviceUnavailable({
        connected: false,
        broker: 'kraken',
        error: 'Failed to connect. Check KRAKEN_API_KEY and KRAKEN_API_SECRET.',
      })
    }

    // Default: IBKR
    const result = await IBKRService.connect()
    if (result) {
      return response.json({ connected: true, broker: 'ibkr', message: 'Connected to IB TWS/Gateway' })
    }
    return response.serviceUnavailable({
      connected: false,
      broker: 'ibkr',
      error: 'Failed to connect. Ensure TWS or IB Gateway is running.',
    })
  }

  /**
   * Disconnect from a broker
   */
  public async disconnect({ request, response }: HttpContext) {
    const broker = (request.input('broker', 'ibkr') as string).toLowerCase()

    if (broker === 'kraken') {
      KrakenService.disconnect()
      return response.json({ connected: false, broker: 'kraken', message: 'Disconnected from Kraken' })
    }

    IBKRService.disconnect()
    return response.json({ connected: false, broker: 'ibkr', message: 'Disconnected from IB' })
  }

  /**
   * Get account summary for a specific broker
   */
  public async account({ request, response }: HttpContext) {
    const broker = (request.input('broker', 'ibkr') as string).toLowerCase()

    if (broker === 'kraken') {
      if (!KrakenService.isConnected) {
        return response.serviceUnavailable({ error: 'Not connected to Kraken' })
      }
      const [balance, tradeBalance] = await Promise.all([
        KrakenService.getBalance(),
        KrakenService.getTradeBalance(),
      ])
      return response.json({ balance, tradeBalance })
    }

    if (!IBKRService.isConnected) {
      return response.serviceUnavailable({ error: 'Not connected to IB' })
    }
    const summary = await IBKRService.getAccountSummary()
    return response.json(summary)
  }

  /**
   * Get portfolio positions
   */
  public async positions({ request, response }: HttpContext) {
    const broker = (request.input('broker', 'ibkr') as string).toLowerCase()

    if (broker === 'kraken') {
      if (!KrakenService.isConnected) {
        return response.serviceUnavailable({ error: 'Not connected to Kraken' })
      }
      const positions = await KrakenService.getOpenPositions()
      return response.json(positions)
    }

    if (!IBKRService.isConnected) {
      return response.serviceUnavailable({ error: 'Not connected to IB' })
    }
    const positions = await IBKRService.getPositions()
    return response.json(positions)
  }

  /**
   * Place a new order
   */
  public async placeOrder({ request, response }: HttpContext) {
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
    const broker = (request.input('broker', 'ibkr') as string).toLowerCase() as Broker

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
    if (!['ibkr', 'kraken'].includes(broker)) {
      return response.badRequest({ error: 'broker must be ibkr or kraken' })
    }

    // Find or reference the ticker
    let ticker = await Ticker.findBy('symbol', symbol)
    if (!ticker) {
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
      broker,
      analysisId,
      status: 'pending',
      filledQuantity: 0,
    })

    // Submit order via BullMQ
    await QueueService.addJob(QUEUE_NAMES.SUBMIT_ORDER, { tradeId: trade.id })

    return response.created({
      trade: trade.serialize(),
      message: `Order queued for submission via ${broker.toUpperCase()}`,
    })
  }

  /**
   * Cancel an active order
   */
  public async cancelOrder({ params, response }: HttpContext) {
    const trade = await Trade.findOrFail(params.id)

    if (['filled', 'cancelled', 'error'].includes(trade.status)) {
      return response.badRequest({ error: `Cannot cancel order in ${trade.status} status` })
    }

    let updated: Trade
    if (trade.broker === 'kraken') {
      updated = await KrakenService.cancelOrderAny(trade)
    } else {
      updated = await IBKRService.cancelOrder(trade)
    }

    return response.json({ trade: updated.serialize(), message: 'Cancel requested' })
  }

  /**
   * List all trades with filters
   */
  public async index({ request, response }: HttpContext) {
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
  public async show({ params, response }: HttpContext) {
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
  public async stats({ request, response }: HttpContext) {
    const symbol = request.input('symbol')

    // Parameterized: the symbol is user input and must not be interpolated
    // into the SQL text.
    const whereClause = symbol ? 'WHERE t.symbol = ?' : ''
    const whereParams = symbol ? [symbol.toUpperCase()] : []

    // MySQL raw() returns [rows, fields]; better-sqlite3 returns the rows array.
    const unwrap = (res: any): any[] => (Array.isArray(res?.[0]) ? res[0] : res)

    const [overviewRes, bySymbolRes, byStatusRes, recentFills] = await Promise.all([
      db.rawQuery(`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) as buy_count,
          SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) as sell_count,
          SUM(CASE WHEN status = 'filled' THEN filled_quantity * fill_price ELSE 0 END) as total_volume,
          SUM(COALESCE(commission, 0)) as total_commission,
          SUM(COALESCE(realized_pnl, 0)) as total_realized_pnl
        FROM trades t
        ${whereClause}
      `, whereParams),
      db.rawQuery(`
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
      db.rawQuery(`
        SELECT status, COUNT(*) as count
        FROM trades t
        ${whereClause}
        GROUP BY status
      `, whereParams),
      Trade.query()
        .where('status', 'filled')
        .preload('ticker')
        .orderBy('filled_at', 'desc')
        .limit(10),
    ])

    return response.json({
      overview: unwrap(overviewRes)[0],
      bySymbol: unwrap(bySymbolRes),
      byStatus: unwrap(byStatusRes),
      recentFills: recentFills.map((t) => t.serialize()),
    })
  }
}
