import type { HttpContext } from '@adonisjs/core/http'
import MeilisearchService from '#services/MeilisearchService'
import QueueService, { QUEUE_NAMES } from '#jobs/QueueService'

export default class ArticlesController {
  public async index({ request, response }: HttpContext) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 20)
    const source = request.input('source')
    const analyzed = request.input('analyzed')
    const sentiment = request.input('sentiment')

    const result = await MeilisearchService.getArticles({
      page,
      limit,
      source,
      analyzed: analyzed !== undefined ? analyzed === 'true' : undefined,
      sentiment,
    })

    return response.json({
      meta: {
        total: result.total,
        per_page: result.perPage,
        current_page: result.page,
        last_page: result.lastPage,
      },
      data: result.data,
    })
  }

  public async show({ params, response }: HttpContext) {
    const article = await MeilisearchService.getArticle(Number(params.id))
    if (!article) return response.notFound({ error: 'Article not found' })

    // Fetch analyses for this article
    const { hits: analyses } = await MeilisearchService['searchIndex']('analyses', {
      filter: `articleId = ${article.id}`,
      sort: ['relevanceScore:desc'],
      limit: 50,
    })

    return response.json({ ...article, analyses })
  }

  public async search({ request, response }: HttpContext) {
    const results = await MeilisearchService.searchArticles({
      query: request.input('q'),
      ticker: request.input('ticker'),
      sentiment: request.input('sentiment'),
      source: request.input('source'),
      from: request.input('from', 0),
      size: request.input('size', 20),
      dateFrom: request.input('date_from'),
      dateTo: request.input('date_to'),
    })

    return response.json(results)
  }

  public async triggerScrape({ request, response }: HttpContext) {
    const sourceId = request.input('source_id')

    await QueueService.addJob(QUEUE_NAMES.SCRAPE_NEWS, { sourceId })

    return response.json({ message: 'Scrape job queued', sourceId })
  }

  public async triggerAnalysis({ request, response }: HttpContext) {
    const limit = request.input('limit', 50)

    const unanalyzed = await MeilisearchService.getUnanalyzedArticles(limit)

    if (unanalyzed.length === 0) {
      return response.json({ message: 'No unanalyzed articles found' })
    }

    await QueueService.addBulk(
      QUEUE_NAMES.ANALYZE_ARTICLE,
      unanalyzed.map((a) => ({ data: { articleId: a.id } }))
    )

    return response.json({
      message: `Queued ${unanalyzed.length} articles for analysis`,
      count: unanalyzed.length,
    })
  }

  public async backfill({ request, response }: HttpContext) {
    const { default: Ticker } = await import('#models/Ticker')
    const symbol = request.input('symbol', '')
    const days = Number(request.input('days', 1825))
    const fetchContent = request.input('fetch_content', false)

    let tickers: any[]
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

    await QueueService.addBulk(
      QUEUE_NAMES.BACKFILL_NEWS,
      tickers.map((t) => ({
        data: { symbol: t.symbol, days, fetchContent },
      }))
    )

    return response.json({
      message: `News backfill queued for ${tickers.length} tickers (${days} days)`,
      queued: tickers.length,
    })
  }

  public async sources({ response }: HttpContext) {
    const { default: ScrapeSource } = await import('#models/ScrapeSource')
    const sources = await ScrapeSource.query().orderBy('name')
    return response.json(sources)
  }
}
