import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Article from 'App/Models/Article'
import Ticker from 'App/Models/Ticker'
import Analysis from 'App/Models/Analysis'
import QueueService from 'App/Jobs/QueueService'
import Database from '@ioc:Adonis/Lucid/Database'
import Logger from '@ioc:Adonis/Core/Logger'
import OpenSearchService from 'App/Services/OpenSearchService'

export default class DashboardController {
  public async index({ response }: HttpContextContract) {
    const [
      totalArticles,
      totalTickers,
      totalAnalyses,
      unanalyzedCount,
      queueStats,
      recentAnalyses,
      sentimentDistribution,
    ] = await Promise.all([
      Article.query().count('* as total').first(),
      Ticker.query().where('is_active', true).count('* as total').first(),
      Analysis.query().count('* as total').first(),
      Article.query().where('is_analyzed', false).count('* as total').first(),
      QueueService.getAllStats(),
      Analysis.query()
        .preload('article')
        .preload('ticker')
        .orderBy('created_at', 'desc')
        .limit(20),
      Database.rawQuery(`
        SELECT sentiment, COUNT(*) as count
        FROM analyses
        GROUP BY sentiment
        ORDER BY count DESC
      `),
    ])

    const topTickers = await Database.rawQuery(`
      SELECT t.symbol, t.name, t.current_price,
             COUNT(a.id) as analysis_count,
             AVG(a.sentiment_score) as avg_sentiment
      FROM tickers t
      LEFT JOIN analyses a ON a.ticker_id = t.id
      WHERE t.is_active = true
      GROUP BY t.id
      ORDER BY analysis_count DESC
      LIMIT 10
    `)

    return response.json({
      stats: {
        totalArticles: Number(totalArticles?.$extras.total || 0),
        totalTickers: Number(totalTickers?.$extras.total || 0),
        totalAnalyses: Number(totalAnalyses?.$extras.total || 0),
        unanalyzedArticles: Number(unanalyzedCount?.$extras.total || 0),
      },
      queues: queueStats,
      recentAnalyses: recentAnalyses.map((a) => a.serialize()),
      sentimentDistribution: sentimentDistribution[0],
      topTickers: topTickers[0],
    })
  }

  public async activeJobs({ response }: HttpContextContract) {
    const jobs = await QueueService.getActiveJobs()
    return response.json({ jobs })
  }

  public async failedJobs({ request, response }: HttpContextContract) {
    const limit = request.input('limit', 50)
    const jobs = await QueueService.getFailedJobs(limit)
    return response.json({ jobs })
  }

  public async retryJob({ params, response }: HttpContextContract) {
    const { queue, id } = params
    const success = await QueueService.retryJob(queue, id)
    if (!success) {
      return response.notFound({ error: 'Job not found' })
    }
    return response.json({ message: 'Job queued for retry' })
  }

  public async removeFailedJob({ params, response }: HttpContextContract) {
    const { queue, id } = params
    const success = await QueueService.removeFailedJob(queue, id)
    if (!success) {
      return response.notFound({ error: 'Job not found' })
    }
    return response.json({ message: 'Job removed' })
  }

  public async prune({ response }: HttpContextContract) {
    Logger.info('Pruning entire database...')

    // Delete in FK-safe order, preserving tickers and their snapshots
    await Database.rawQuery('DELETE FROM trades')
    await Database.rawQuery('DELETE FROM analyses')
    await Database.rawQuery('DELETE FROM articles')
    await Database.rawQuery('DELETE FROM scrape_sources')

    // Clear OpenSearch indices
    const osClient = await OpenSearchService.getClient()
    for (const index of ['syphon-articles', 'syphon-logs']) {
      try {
        const exists = await osClient.indices.exists({ index })
        if (exists.body) {
          await osClient.deleteByQuery({
            index,
            body: { query: { match_all: {} } },
            refresh: true,
          })
        }
      } catch {
        // index may not exist yet
      }
    }

    // Drain BullMQ queues
    await QueueService.drainAll()

    Logger.info('Database pruned successfully')
    return response.json({ message: 'All data pruned successfully' })
  }
}
