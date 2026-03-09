import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Analysis from 'App/Models/Analysis'
import Database from '@ioc:Adonis/Lucid/Database'

export default class AnalysisController {
  public async index({ request, response }: HttpContextContract) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 20)
    const tickerSymbol = request.input('ticker')
    const sentiment = request.input('sentiment')
    const sortBy = request.input('sort', 'created_at')
    const sortDir = request.input('dir', 'desc')

    const query = Analysis.query()
      .preload('article')
      .preload('ticker')

    if (tickerSymbol) {
      query.whereHas('ticker', (q) => q.where('symbol', tickerSymbol.toUpperCase()))
    }

    if (sentiment) {
      query.where('sentiment', sentiment)
    }

    const validSorts = ['created_at', 'sentiment_score', 'relevance_score', 'confidence']
    const sort = validSorts.includes(sortBy) ? sortBy : 'created_at'
    const dir = sortDir === 'asc' ? 'asc' : 'desc'
    query.orderBy(sort, dir as 'asc' | 'desc')

    const analyses = await query.paginate(page, limit)
    return response.json(analyses)
  }

  public async show({ params, response }: HttpContextContract) {
    const analysis = await Analysis.query()
      .where('id', params.id)
      .preload('article')
      .preload('ticker', (q) => q.preload('snapshots', (sq) => sq.orderBy('date', 'desc').limit(30)))
      .firstOrFail()

    return response.json(analysis.serialize())
  }

  public async timeline({ request, response }: HttpContextContract) {
    const tickerSymbol = request.input('ticker')
    const days = request.input('days', 30)

    if (!tickerSymbol) {
      return response.badRequest({ error: 'ticker parameter required' })
    }

    const timeline = await Database.rawQuery(`
      SELECT
        DATE(a.created_at) as date,
        AVG(a.sentiment_score) as avg_sentiment,
        COUNT(*) as article_count,
        ts.close as price
      FROM analyses a
      JOIN tickers t ON t.id = a.ticker_id
      LEFT JOIN ticker_snapshots ts ON ts.ticker_id = t.id AND ts.date = DATE(a.created_at)
      WHERE t.symbol = ? AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE(a.created_at), ts.close
      ORDER BY date ASC
    `, [tickerSymbol.toUpperCase(), days])

    return response.json(timeline[0])
  }

  public async stats({ response }: HttpContextContract) {
    const [overall, byTicker, recent] = await Promise.all([
      Database.rawQuery(`
        SELECT
          COUNT(*) as total,
          AVG(sentiment_score) as avg_sentiment,
          AVG(confidence) as avg_confidence,
          SUM(CASE WHEN sentiment IN ('bullish', 'very_bullish') THEN 1 ELSE 0 END) as bullish_count,
          SUM(CASE WHEN sentiment IN ('bearish', 'very_bearish') THEN 1 ELSE 0 END) as bearish_count,
          SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neutral_count
        FROM analyses
      `),
      Database.rawQuery(`
        SELECT t.symbol, t.name,
          COUNT(a.id) as analysis_count,
          AVG(a.sentiment_score) as avg_sentiment,
          AVG(a.confidence) as avg_confidence
        FROM tickers t
        JOIN analyses a ON a.ticker_id = t.id
        GROUP BY t.id
        ORDER BY analysis_count DESC
        LIMIT 20
      `),
      Analysis.query()
        .preload('article')
        .preload('ticker')
        .orderBy('created_at', 'desc')
        .limit(10),
    ])

    return response.json({
      overall: overall[0][0],
      byTicker: byTicker[0],
      recent: recent.map((a) => a.serialize()),
    })
  }
}
