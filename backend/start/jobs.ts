import Logger from '@ioc:Adonis/Core/Logger'
import cron from 'node-cron'
import Env from '@ioc:Adonis/Core/Env'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'
import { registerScrapeNewsWorker } from 'App/Jobs/ScrapeNewsJob'
import { registerAnalyzeArticleWorker } from 'App/Jobs/AnalyzeArticleJob'
import { registerFetchTickerWorker, queueAllTickerRefresh } from 'App/Jobs/FetchTickerJob'
import { registerSubmitOrderWorker } from 'App/Jobs/SubmitOrderJob'
import { registerMonitorOrderWorker } from 'App/Jobs/MonitorOrderJob'
import ScraperService from 'App/Services/ScraperService'
import OpenSearchService from 'App/Services/OpenSearchService'

async function boot() {
  try {
    // Ensure OpenSearch index exists
    await OpenSearchService.ensureIndex()
    Logger.info('OpenSearch index ready')

    // Ensure default scrape sources
    await ScraperService.ensureDefaultSources()
    Logger.info('Scrape sources initialized')

    // Register BullMQ workers
    registerScrapeNewsWorker()
    registerAnalyzeArticleWorker()
    registerFetchTickerWorker()
    registerSubmitOrderWorker()
    registerMonitorOrderWorker()
    Logger.info('BullMQ workers registered')

    // Schedule recurring scrape job
    const interval = Env.get('SCRAPE_INTERVAL_MINUTES', 30)
    cron.schedule(`*/${interval} * * * *`, async () => {
      Logger.info('[Cron] Triggering news scrape')
      await QueueService.addJob(QUEUE_NAMES.SCRAPE_NEWS, {})
    })

    // Schedule ticker refresh every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
      Logger.info('[Cron] Triggering ticker refresh')
      await queueAllTickerRefresh()
    })

    Logger.info('Cron jobs scheduled (scrape every %d min, ticker refresh every 30min)', interval)
  } catch (error) {
    Logger.error('Failed to boot jobs: %s', error.message)
  }
}

boot()
