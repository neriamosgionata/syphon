import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Ticker from 'App/Models/Ticker'
import YahooFinanceService from 'App/Services/YahooFinanceService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'
import Database from '@ioc:Adonis/Lucid/Database'

export default class TickersController {
  public async index({ request, response }: HttpContextContract) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 20)

    const tickers = await Ticker.query()
      .where('is_active', true)
      .orderBy('symbol')
      .paginate(page, limit)

    return response.json(tickers)
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

    const results = await YahooFinanceService.searchTicker(query)
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

  public async remove({ params, response }: HttpContextContract) {
    const ticker = await Ticker.query()
      .where('symbol', params.symbol.toUpperCase())
      .firstOrFail()

    ticker.isActive = false
    await ticker.save()

    return response.json({ message: `${ticker.symbol} deactivated` })
  }
}
