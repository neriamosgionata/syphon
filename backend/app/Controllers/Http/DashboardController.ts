import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Ticker from 'App/Models/Ticker'
import QueueService from 'App/Jobs/QueueService'
import Database from '@ioc:Adonis/Lucid/Database'
import Logger from '@ioc:Adonis/Core/Logger'
import MeilisearchService from 'App/Services/MeilisearchService'

export default class DashboardController {
  public async index({ response }: HttpContextContract) {
    const [
      totalArticles,
      totalTickers,
      totalAnalyses,
      unanalyzedCount,
      queueStats,
      recentAnalyses,
    ] = await Promise.all([
      MeilisearchService.countArticles(),
      Ticker.query().where('is_active', true).count('* as total').first(),
      MeilisearchService.countAnalyses(),
      MeilisearchService.countArticles('isAnalyzed = false'),
      QueueService.getAllStats(),
      MeilisearchService.getRecentAnalyses(20),
    ])

    // Sentiment distribution from analyses
    const allAnalyses = await MeilisearchService['searchIndex']('analyses', {
      limit: 50000,
    })
    const sentimentCounts: Record<string, number> = {}
    for (const a of allAnalyses.hits) {
      sentimentCounts[a.sentiment] = (sentimentCounts[a.sentiment] || 0) + 1
    }
    const sentimentDistribution = Object.entries(sentimentCounts)
      .map(([sentiment, count]) => ({ sentiment, count }))
      .sort((a, b) => b.count - a.count)

    // Top tickers by analysis count
    const tickerCounts = new Map<number, { symbol: string; name: string; count: number; sentSum: number }>()
    for (const a of allAnalyses.hits) {
      const entry = tickerCounts.get(a.tickerId) || { symbol: a.tickerSymbol || '', name: '', count: 0, sentSum: 0 }
      entry.count++
      entry.sentSum += Number(a.sentimentScore) || 0
      tickerCounts.set(a.tickerId, entry)
    }

    // Enrich with ticker data from MariaDB (small table)
    const tickerIds = [...tickerCounts.keys()]
    const tickers = tickerIds.length > 0 ? await Ticker.query().whereIn('id', tickerIds).where('is_active', true) : []
    const tickerMap = new Map(tickers.map((t) => [t.id, t] as const))

    const topTickers = [...tickerCounts.entries()]
      .map(([id, data]) => {
        const t = tickerMap.get(id)
        return {
          symbol: t?.symbol || data.symbol,
          name: t?.name || data.name,
          current_price: t?.currentPrice || null,
          analysis_count: data.count,
          avg_sentiment: data.count > 0 ? data.sentSum / data.count : 0,
        }
      })
      .sort((a, b) => b.analysis_count - a.analysis_count)
      .slice(0, 10)

    return response.json({
      stats: {
        totalArticles,
        totalTickers: Number(totalTickers?.$extras.total || 0),
        totalAnalyses,
        unanalyzedArticles: unanalyzedCount,
      },
      queues: queueStats,
      recentAnalyses,
      sentimentDistribution,
      topTickers,
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

  public async cancelJob({ params, response }: HttpContextContract) {
    const { queue, id } = params
    const result = await QueueService.cancelJob(queue, id)
    if (!result.cancelled) {
      return response.notFound({ error: `Cannot cancel job (state: ${result.state})` })
    }
    return response.json({ message: 'Job cancelled', state: result.state })
  }

  public async drainQueues({ response }: HttpContextContract) {
    Logger.info('Draining all queues...')
    await QueueService.drainAll()
    Logger.info('All queues drained')
    return response.json({ message: 'All queues drained successfully' })
  }

  public async prune({ response }: HttpContextContract) {
    Logger.info('Pruning entire database...')

    // Delete from MariaDB (only small tables remain)
    await Database.rawQuery('DELETE FROM trades')
    await Database.rawQuery('DELETE FROM scrape_sources')

    // Clear all Meilisearch indexes
    try {
      await MeilisearchService.deleteAllArticles()
      await MeilisearchService.deleteAllAnalyses()
      await MeilisearchService.deleteAllSnapshots()
      await MeilisearchService.deleteAllDecisions()
      await MeilisearchService.deleteAllLogs()
    } catch {
      // indexes may not exist yet
    }

    // Drain BullMQ queues
    await QueueService.drainAll()

    Logger.info('Database pruned successfully')
    return response.json({ message: 'All data pruned successfully' })
  }
}
