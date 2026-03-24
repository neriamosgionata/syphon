import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Ticker from 'App/Models/Ticker'
import FinanceService from 'App/Services/FinanceService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'
import Database from '@ioc:Adonis/Lucid/Database'

export default class TickersController {
  public async index({ request, response }: HttpContextContract) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 20)
    const sector = request.input('sector', '')
    const exchange = request.input('exchange', '')
    const sentiment = request.input('sentiment', '')
    const sort = request.input('sort', 'symbol')
    const dir = request.input('dir', 'asc') === 'desc' ? 'desc' as const : 'asc' as const
    const search = request.input('search', '')

    const query = Ticker.query().where('is_active', true)

    if (search) {
      query.where((q) => {
        q.where('symbol', 'like', `%${search.toUpperCase()}%`)
          .orWhere('name', 'like', `%${search}%`)
      })
    }

    if (sector) {
      query.where('sector', sector)
    }

    if (exchange) {
      query.where('exchange', exchange)
    }

    if (sentiment) {
      const sentimentMap: Record<string, string> = {
        bullish: '> 0',
        bearish: '< 0',
        neutral: '= 0',
      }
      const condition = sentimentMap[sentiment]
      if (condition) {
        query.whereIn('id', Database.rawQuery(
          `SELECT ticker_id FROM analyses GROUP BY ticker_id HAVING AVG(sentiment_score) ${condition}`
        ))
      }
    }

    const validSorts = ['symbol', 'name', 'current_price', 'market_cap', 'sector', 'exchange']
    const sortCol = validSorts.includes(sort) ? sort : 'symbol'
    query.orderBy(sortCol, dir)

    const tickers = await query.paginate(page, limit)

    // Fetch distinct sectors and exchanges for filter options
    const sectors = await Database.rawQuery(
      `SELECT DISTINCT sector FROM tickers WHERE is_active = 1 AND sector IS NOT NULL AND sector != '' ORDER BY sector`
    )
    const exchanges = await Database.rawQuery(
      `SELECT DISTINCT exchange FROM tickers WHERE is_active = 1 AND exchange IS NOT NULL AND exchange != '' ORDER BY exchange`
    )

    return response.json({
      ...tickers.toJSON(),
      filters: {
        sectors: (sectors[0] || []).map((r: any) => r.sector),
        exchanges: (exchanges[0] || []).map((r: any) => r.exchange),
      },
    })
  }

  public async show({ params, response }: HttpContextContract) {
    const ticker = await Ticker.query()
      .where('symbol', params.symbol.toUpperCase())
      .preload('snapshots', (q) => q.orderBy('date', 'desc').limit(90))
      .firstOrFail()

    const analyses = await ticker.related('analyses').query()
      .preload('article')
      .orderBy('created_at', 'desc')
      .limit(50)

    const sentimentSummary = await Database.rawQuery(`
      SELECT
        sentiment,
        COUNT(*) as count,
        AVG(sentiment_score) as avg_score,
        AVG(confidence) as avg_confidence
      FROM analyses
      WHERE ticker_id = ?
      GROUP BY sentiment
    `, [ticker.id])

    return response.json({
      ticker: ticker.serialize(),
      analyses: analyses.map((a) => a.serialize()),
      sentimentSummary: sentimentSummary[0],
    })
  }

  public async search({ request, response }: HttpContextContract) {
    const query = request.input('q', '')
    if (query.length < 1) {
      return response.json([])
    }

    const results = await FinanceService.searchTicker(query)
    return response.json(results)
  }

  public async add({ request, response }: HttpContextContract) {
    const symbol = request.input('symbol', '').toUpperCase()
    if (!symbol) {
      return response.badRequest({ error: 'Symbol is required' })
    }

    const existing = await Ticker.findBy('symbol', symbol)
    if (existing) {
      return response.json({ ticker: existing, message: 'Ticker already exists' })
    }

    await QueueService.addJob(QUEUE_NAMES.FETCH_TICKER, {
      symbol,
      syncHistory: true,
    })

    return response.json({ message: `Ticker ${symbol} queued for sync` })
  }

  public async refresh({ params, response }: HttpContextContract) {
    const symbol = params.symbol.toUpperCase()

    await QueueService.addJob(QUEUE_NAMES.FETCH_TICKER, {
      symbol,
      syncHistory: true,
    })

    return response.json({ message: `Refresh queued for ${symbol}` })
  }

  public async refreshAll({ response }: HttpContextContract) {
    const tickers = await Ticker.query().where('is_active', true)
    if (tickers.length === 0) {
      return response.json({ message: 'No active tickers to refresh', queued: 0 })
    }

    // Use a single bulk job to avoid flooding the queue with 100+ individual jobs
    // Each job still goes through the rate limiter, but we batch them to reduce overhead
    const batchSize = 10
    const batches: string[][] = []
    for (let i = 0; i < tickers.length; i += batchSize) {
      batches.push(tickers.slice(i, i + batchSize).map((t) => t.symbol))
    }

    await QueueService.addBulk(
      QUEUE_NAMES.FETCH_TICKER,
      batches.map((symbols) => ({ data: { symbols, syncHistory: true } }))
    )

    return response.json({
      message: `Queued ${tickers.length} tickers for refresh in ${batches.length} batches`,
      queued: tickers.length,
    })
  }

  public async backfill({ request, response }: HttpContextContract) {
    const days = Number(request.input('days', 365))
    const symbol = request.input('symbol', '')

    let tickers: Ticker[]
    if (symbol) {
      const ticker = await Ticker.findBy('symbol', symbol.toUpperCase())
      if (!ticker) return response.notFound({ error: 'Ticker not found' })
      tickers = [ticker]
    } else {
      tickers = await Ticker.query().where('is_active', true)
    }

    if (tickers.length === 0) {
      return response.json({ message: 'No active tickers', queued: 0 })
    }

    // Queue individual backfill jobs — each just downloads Stooq CSV + saves snapshots
    await QueueService.addBulk(
      QUEUE_NAMES.FETCH_TICKER,
      tickers.map((t) => ({
        data: { symbol: t.symbol, backfillOnly: true, backfillDays: days },
      }))
    )

    return response.json({
      message: `Backfill queued for ${tickers.length} tickers (${days} days)`,
      queued: tickers.length,
    })
  }

  public async remove({ params, response }: HttpContextContract) {
    const ticker = await Ticker.query()
      .where('symbol', params.symbol.toUpperCase())
      .firstOrFail()

    ticker.isActive = false
    await ticker.save()

    return response.json({ message: `${ticker.symbol} deactivated` })
  }
}
