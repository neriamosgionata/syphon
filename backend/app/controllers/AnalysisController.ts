import type { HttpContext } from '@adonisjs/core/http'
import MeilisearchService from '#services/MeilisearchService'
import Ticker from '#models/Ticker'

export default class AnalysisController {
  public async index({ request, response }: HttpContext) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 20)
    const tickerSymbol = request.input('ticker')
    const sentiment = request.input('sentiment')
    const sortBy = request.input('sort', 'createdAt')
    const sortDir = request.input('dir', 'desc')

    const validSorts = ['createdAt', 'sentimentScore', 'relevanceScore', 'confidence']
    const sort = validSorts.includes(sortBy) ? sortBy : 'createdAt'
    const dir = sortDir === 'asc' ? 'asc' : 'desc'

    const result = await MeilisearchService.getAnalyses({
      page,
      limit,
      tickerSymbol,
      sentiment,
      sort,
      dir: dir as 'asc' | 'desc',
    })

    // Enrich with ticker data
    const tickerIds = [...new Set(result.data.map((a: any) => a.tickerId))]
    const tickers = tickerIds.length > 0
      ? await Ticker.query().whereIn('id', tickerIds)
      : []
    const tickerMap = new Map(tickers.map((t) => [t.id, t.serialize()]))

    const enriched = result.data.map((a: any) => ({
      ...a,
      ticker: tickerMap.get(a.tickerId) || null,
    }))

    return response.json({
      meta: {
        total: result.total,
        per_page: result.perPage,
        current_page: result.page,
        last_page: result.lastPage,
      },
      data: enriched,
    })
  }

  public async show({ params, response }: HttpContext) {
    const analysis = await MeilisearchService.getAnalysis(params.id)
    if (!analysis) return response.notFound({ error: 'Analysis not found' })

    // Fetch related article, ticker, and recent snapshots
    const [article, ticker] = await Promise.all([
      MeilisearchService.getArticle(analysis.articleId),
      Ticker.find(analysis.tickerId),
    ])

    let snapshots: any[] = []
    if (analysis.tickerId) {
      const allSnaps = await MeilisearchService.getSnapshotsForTicker(analysis.tickerId)
      snapshots = allSnaps.slice(-30)
    }

    return response.json({
      ...analysis,
      article: article || null,
      ticker: ticker?.serialize() || null,
      snapshots,
    })
  }

  public async timeline({ request, response }: HttpContext) {
    const tickerSymbol = request.input('ticker')
    const days = request.input('days', 30)

    if (!tickerSymbol) {
      return response.badRequest({ error: 'ticker parameter required' })
    }

    const ticker = await Ticker.findBy('symbol', tickerSymbol.toUpperCase())
    if (!ticker) return response.json([])

    const cutoff = new Date(Date.now() - days * 86400000).toISOString()

    // Fetch analyses and snapshots from Meilisearch
    const [analyses, snapshots] = await Promise.all([
      MeilisearchService.getAnalysesForTicker(ticker.id, cutoff),
      MeilisearchService.getSnapshotsForTicker(ticker.id),
    ])

    // Build snapshot price map (date -> close)
    const priceMap = new Map<string, number>()
    for (const s of snapshots) {
      priceMap.set(s.date, Number(s.close))
    }

    // Group analyses by date and compute aggregates
    const byDate = new Map<string, { scores: number[]; count: number }>()
    for (const a of analyses) {
      const date = (a.createdAt || '').slice(0, 10)
      if (!date) continue
      const entry = byDate.get(date) || { scores: [], count: 0 }
      entry.scores.push(Number(a.sentimentScore) || 0)
      entry.count++
      byDate.set(date, entry)
    }

    const timeline = [...byDate.entries()]
      .map(([date, data]) => ({
        date,
        avg_sentiment: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
        article_count: data.count,
        price: priceMap.get(date) || null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    return response.json(timeline)
  }

  public async stats({ response }: HttpContext) {
    // Fetch all analyses for aggregation
    const allAnalyses = await MeilisearchService['searchIndex']('analyses', {
      sort: ['createdAt:desc'],
      limit: 50000,
    })

    const analyses = allAnalyses.hits

    // Overall stats
    const total = analyses.length
    const avgSentiment = total > 0
      ? analyses.reduce((s: number, a: any) => s + (Number(a.sentimentScore) || 0), 0) / total
      : 0
    const avgConfidence = total > 0
      ? analyses.reduce((s: number, a: any) => s + (Number(a.confidence) || 0), 0) / total
      : 0

    const sentimentCounts: Record<string, number> = {}
    for (const a of analyses) {
      sentimentCounts[a.sentiment] = (sentimentCounts[a.sentiment] || 0) + 1
    }

    const bullishCount = (sentimentCounts['bullish'] || 0) + (sentimentCounts['very_bullish'] || 0)
    const bearishCount = (sentimentCounts['bearish'] || 0) + (sentimentCounts['very_bearish'] || 0)
    const neutralCount = sentimentCounts['neutral'] || 0

    // By ticker
    const byTickerMap = new Map<number, { symbol: string; count: number; sentSum: number; confSum: number }>()
    for (const a of analyses) {
      const entry = byTickerMap.get(a.tickerId) || {
        symbol: a.tickerSymbol || '',
        count: 0,
        sentSum: 0,
        confSum: 0,
      }
      entry.count++
      entry.sentSum += Number(a.sentimentScore) || 0
      entry.confSum += Number(a.confidence) || 0
      byTickerMap.set(a.tickerId, entry)
    }

    // Enrich with ticker names
    const tickerIds = [...byTickerMap.keys()]
    const tickers = tickerIds.length > 0
      ? await Ticker.query().whereIn('id', tickerIds)
      : []
    const tickerNameMap = new Map(tickers.map((t) => [t.id, t.name]))

    const byTicker = [...byTickerMap.entries()]
      .map(([id, data]) => ({
        symbol: data.symbol,
        name: tickerNameMap.get(id) || data.symbol,
        analysis_count: data.count,
        avg_sentiment: data.sentSum / data.count,
        avg_confidence: data.confSum / data.count,
      }))
      .sort((a, b) => b.analysis_count - a.analysis_count)
      .slice(0, 20)

    // Recent 10
    const recent = analyses.slice(0, 10)

    return response.json({
      overall: {
        total,
        avg_sentiment: avgSentiment,
        avg_confidence: avgConfidence,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        neutral_count: neutralCount,
      },
      byTicker,
      recent,
    })
  }
}
