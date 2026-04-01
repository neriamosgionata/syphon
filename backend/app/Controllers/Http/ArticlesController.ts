import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import MeilisearchService from 'App/Services/MeilisearchService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'

export default class ArticlesController {
  public async index({ request, response }: HttpContextContract) {
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

  public async show({ params, response }: HttpContextContract) {
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

  public async search({ request, response }: HttpContextContract) {
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

  public async triggerScrape({ request, response }: HttpContextContract) {
    const sourceId = request.input('source_id')

    await QueueService.addJob(QUEUE_NAMES.SCRAPE_NEWS, { sourceId })

    return response.json({ message: 'Scrape job queued', sourceId })
  }

  public async triggerAnalysis({ request, response }: HttpContextContract) {
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

  public async backfill({ request, response }: HttpContextContract) {
    const { default: Ticker } = await import('App/Models/Ticker')
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

  public async sources({ response }: HttpContextContract) {
    const { default: ScrapeSource } = await import('App/Models/ScrapeSource')
    const sources = await ScrapeSource.query().orderBy('name')
    return response.json(sources)
  }
}
