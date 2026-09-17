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
import FundingCarryService from '#services/FundingCarryService'
import TickRecorderService from '#services/TickRecorderService'
import BarRecorderService from '#services/BarRecorderService'
import TrendEvalService from '#services/TrendEvalService'

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

      // Always-on 1s tick recorder: Kraken WS trades → tick_records. This
      // accumulates the Kraken-native 1s history the fast algo backtests
      // run on (REST OHLC has no sub-minute data). Symbols follow the algo
      // watchlist; public stream, no API keys needed.
      const cfg = await AlgoConfig.getConfig()
      const recordSymbols = cfg.fastWatchlist.length > 0 ? cfg.fastWatchlist : ['BTC', 'ETH', 'SOL']
      TickRecorderService.start(recordSymbols)

      // Always-on multi-interval bar recorder: Kraken OHLC only serves 720
      // candles per interval, so the slow-trend evaluation's 5m/1h/1d series
      // must be recorded forward into bar_records.
      BarRecorderService.start(recordSymbols)

      // Slow trend paper evaluator: replays the recorded bars through the
      // same BacktestEngine the backtests use and latches the product's own
      // tripwires. Paper only — no order path exists.
      TrendEvalService.start()

      // Funding-carry paper loop (delta-neutral perp premium harvest).
      // Dry-run by default — logs intents, records paper P&L. Real execution
      // requires the Kraken Futures executor + keys (not yet wired).
      cron.schedule('0 * * * *', async () => {
        logger.info('[Cron] Funding-carry paper tick')
        await FundingCarryService.tick()
      })
      logger.info('Funding-carry hourly paper tick scheduled')

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
