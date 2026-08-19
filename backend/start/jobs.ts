import logger from '@adonisjs/core/services/logger'
import app from '@adonisjs/core/services/app'
import cron from 'node-cron'
import env from '#start/env'
import QueueService, { QUEUE_NAMES } from '#jobs/QueueService'
import { registerScrapeNewsWorker } from '#jobs/ScrapeNewsJob'
import { registerAnalyzeArticleWorker } from '#jobs/AnalyzeArticleJob'
import { registerFetchTickerWorker, queueAllTickerRefresh } from '#jobs/FetchTickerJob'
import { registerSubmitOrderWorker } from '#jobs/SubmitOrderJob'
import { registerMonitorOrderWorker } from '#jobs/MonitorOrderJob'
import { registerBackfillNewsWorker } from '#jobs/BackfillNewsJob'
import ScraperService from '#services/ScraperService'
import MeilisearchService from '#services/MeilisearchService'
import AlgoConfig from '#models/AlgoConfig'
import FastAlgoService from '#services/FastAlgoService'

async function boot() {
  try {
    // Ensure Meilisearch indexes exist
    await MeilisearchService.ensureIndex()
    logger.info('Meilisearch indexes ready')

    // Ensure default scrape sources
    await ScraperService.ensureDefaultSources()
    logger.info('Scrape sources initialized')

    // Ensure algo config defaults
    await AlgoConfig.ensureDefault()
    logger.info('Algo config initialized')

    // BullMQ workers and cron only make sense in a long-running server process.
    // Ace commands that manage the schema (migration/seed/refresh) run in the
    // "console" environment and release every DB connection at the end of their
    // run — spawning workers there is both wrong and fragile.
    if (app.getEnvironment() !== 'web') {
      logger.info('[Jobs] Skipping workers/cron (environment: %s)', app.getEnvironment())
      return
    }

    // Register BullMQ workers
    registerScrapeNewsWorker()
    registerAnalyzeArticleWorker()
    registerFetchTickerWorker()
    registerSubmitOrderWorker()
    registerMonitorOrderWorker()
    registerBackfillNewsWorker()
    logger.info('BullMQ workers registered')

    // Intraminute algo loop (fast trading merged into the algo system).
    // Self-contained: idles unless algo_config has fastEnabled + broker=kraken.
    FastAlgoService.start()

    // Recurring jobs are only scheduled for long-running environments. Tests
    // boot the same preloads, and a cron tick mid-suite would enqueue network
    // jobs that only slow the run down.
    if (env.get('NODE_ENV') !== 'test') {
      // Schedule recurring scrape job
      const interval = env.get('SCRAPE_INTERVAL_MINUTES', 30)
      cron.schedule(`*/${interval} * * * *`, async () => {
        logger.info('[Cron] Triggering news scrape')
        await QueueService.addJob(QUEUE_NAMES.SCRAPE_NEWS, {})
      })

      // Schedule ticker refresh every 30 minutes
      cron.schedule('*/30 * * * *', async () => {
        logger.info('[Cron] Triggering ticker refresh')
        await queueAllTickerRefresh()
      })

      logger.info(
        'Cron jobs scheduled (scrape every %d min, ticker refresh every 30min)',
        interval,
      )
    }
  } catch (error) {
    logger.error('Failed to boot jobs: %s', error instanceof Error ? error.message : String(error))
  }
}

// Top-level await is required here: the module import must not resolve until the
// job infrastructure is fully booted. A fire-and-forget `boot()` lets `app.start()`
// finish early, so a following ace command (e.g. migration:run, which releases every
// DB connection at the end of its run) races with — and breaks — this preload.
await boot()
