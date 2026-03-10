import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import ScrapeSource from 'App/Models/ScrapeSource'
import ScraperService from 'App/Services/ScraperService'
import NotificationService from 'App/Services/NotificationService'
import QueueService, { QUEUE_NAMES } from './QueueService'

export async function processScrapeNews(job: Job) {
  const { sourceId } = job.data

  let sources: ScrapeSource[]
  if (sourceId) {
    const source = await ScrapeSource.find(sourceId)
    sources = source ? [source] : []
  } else {
    sources = await ScrapeSource.query().where('is_active', true)
  }

  let totalSaved = 0

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    try {
      await job.updateProgress({
        percent: Math.round((i / sources.length) * 100),
        stage: `Scraping ${source.name}`,
        detail: `Source ${i + 1} of ${sources.length}`,
      })

      Logger.info('[ScrapeNews] Scraping: %s', source.name)
      const articles = await ScraperService.scrapeSource(source)
      const saved = await ScraperService.saveArticles(articles, source)
      totalSaved += saved
      Logger.info('[ScrapeNews] %s: scraped %d articles, saved %d new', source.name, articles.length, saved)

      // Queue analysis for new unanalyzed articles
      const unanalyzed = await source.related('articles').query()
        .where('is_analyzed', false)
        .limit(50)

      if (unanalyzed.length > 0) {
        await QueueService.addBulk(
          QUEUE_NAMES.ANALYZE_ARTICLE,
          unanalyzed.map((a) => ({ data: { articleId: a.id } }))
        )
        Logger.info('[ScrapeNews] Queued %d articles for analysis', unanalyzed.length)
      }
    } catch (error) {
      Logger.error('[ScrapeNews] Error scraping %s: %s', source.name, error.message)
      source.errorCount += 1
      await source.save()
    }
  }

  await job.updateProgress({ percent: 100, stage: 'Complete', detail: `${totalSaved} articles saved` })

  NotificationService.emit({
    type: 'scrape_complete',
    totalSaved,
    sourcesProcessed: sources.length,
    timestamp: new Date().toISOString(),
  })

  return { totalSaved, sourcesProcessed: sources.length }
}

export function registerScrapeNewsWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.SCRAPE_NEWS, processScrapeNews, 2)
}
