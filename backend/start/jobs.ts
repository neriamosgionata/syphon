import Logger from '@ioc:Adonis/Core/Logger'
import cron from 'node-cron'
import Env from '@ioc:Adonis/Core/Env'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'
import { registerScrapeNewsWorker } from 'App/Jobs/ScrapeNewsJob'
import { registerAnalyzeArticleWorker } from 'App/Jobs/AnalyzeArticleJob'
import { registerFetchTickerWorker, queueAllTickerRefresh } from 'App/Jobs/FetchTickerJob'
import { registerSubmitOrderWorker } from 'App/Jobs/SubmitOrderJob'
import { registerMonitorOrderWorker } from 'App/Jobs/MonitorOrderJob'
import { registerBackfillNewsWorker } from 'App/Jobs/BackfillNewsJob'
import { registerAlgoTradingWorker } from 'App/Jobs/AlgoTradingJob'
import ScraperService from 'App/Services/ScraperService'
import MeilisearchService from 'App/Services/MeilisearchService'
import AlgoConfig from 'App/Models/AlgoConfig'

async function boot() {
  try {
    // Ensure Meilisearch indexes exist
    await MeilisearchService.ensureIndex()
    Logger.info('Meilisearch indexes ready')

    // Ensure default scrape sources
    await ScraperService.ensureDefaultSources()
    Logger.info('Scrape sources initialized')

    // Register BullMQ workers
    registerScrapeNewsWorker()
    registerAnalyzeArticleWorker()
    registerFetchTickerWorker()
    registerSubmitOrderWorker()
    registerMonitorOrderWorker()
    registerBackfillNewsWorker()
    registerAlgoTradingWorker()
    Logger.info('BullMQ workers registered')

    // Ensure algo config defaults
    await AlgoConfig.ensureDefault()
    Logger.info('Algo config initialized')

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

    // Schedule algo trading at :15 and :45 (offset from ticker refresh at :00/:30)
    cron.schedule('15,45 * * * *', async () => {
      Logger.info('[Cron] Triggering algo trading run')
      await QueueService.addJob(QUEUE_NAMES.ALGO_TRADING, {})
    })

    Logger.info('Cron jobs scheduled (scrape every %d min, ticker refresh every 30min, algo every 30min offset)', interval)
  } catch (error) {
    Logger.error('Failed to boot jobs: %s', error.message)
  }
}

boot()
