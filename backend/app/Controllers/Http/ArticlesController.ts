import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Article from 'App/Models/Article'
import OpenSearchService from 'App/Services/OpenSearchService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'

export default class ArticlesController {
  public async index({ request, response }: HttpContextContract) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 20)
    const source = request.input('source')
    const analyzed = request.input('analyzed')
    const sentiment = request.input('sentiment')

    const query = Article.query().orderBy('published_at', 'desc')

    if (source) query.where('source_name', source)
    if (analyzed !== undefined) query.where('is_analyzed', analyzed === 'true')
    if (sentiment) {
      query.whereHas('analyses', (subQuery) => {
        subQuery.where('sentiment', sentiment)
      })
    }

    const articles = await query.preload('analyses', (q) => {
      q.preload('ticker')
    }).paginate(page, limit)

    return response.json(articles)
  }

  public async show({ params, response }: HttpContextContract) {
    const article = await Article.query()
      .where('id', params.id)
      .preload('analyses', (q) => {
        q.preload('ticker').orderBy('relevance_score', 'desc')
      })
      .preload('scrapeSource')
      .firstOrFail()

    return response.json(article.serialize())
  }

  public async search({ request, response }: HttpContextContract) {
    const results = await OpenSearchService.searchArticles({
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

    const unanalyzed = await Article.query()
      .where('is_analyzed', false)
      .orderBy('created_at', 'desc')
      .limit(limit)

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

  public async sources({ response }: HttpContextContract) {
    const { default: ScrapeSource } = await import('App/Models/ScrapeSource')
    const sources = await ScrapeSource.query().orderBy('name')
    return response.json(sources)
  }
}
