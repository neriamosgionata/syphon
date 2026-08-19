import { Job } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import FinanceService from '#services/FinanceService'
import Ticker from '#models/Ticker'
import QueueService, { QUEUE_NAMES } from './QueueService.js'

export async function processFetchTicker(job: Job) {
  const { symbol, symbols, syncHistory, backfillOnly, backfillDays } = job.data

  // Backfill-only mode: just download historical data, skip quote refresh
  if (backfillOnly && symbol) {
    logger.info('[FetchTicker] Backfill-only for %s (%d days)', symbol, backfillDays || 1825)
    await job.updateProgress({ percent: 10, stage: 'Backfilling', detail: symbol })
    const ticker = await Ticker.findBy('symbol', symbol.toUpperCase())
    if (!ticker) throw new Error(`Ticker ${symbol} not found`)

    const created = await FinanceService.syncHistoricalSnapshots(ticker, backfillDays || 1825)
    await job.updateProgress({ percent: 100, stage: 'Complete', detail: `${symbol}: ${created} snapshots` })
    logger.info('[FetchTicker] Backfill complete for %s: %d new snapshots', symbol, created)
    return { symbol, snapshotsCreated: created, backfillOnly: true }
  }

  // Bulk mode: sync many symbols in one job using batch API
  if (symbols && Array.isArray(symbols)) {
    await job.updateProgress({ percent: 0, stage: 'Bulk sync', detail: `0/${symbols.length} tickers` })
    logger.info('[FetchTicker] Bulk syncing %d tickers', symbols.length)

    let synced = 0
    let totalSnapshots = 0
    for (let i = 0; i < symbols.length; i++) {
      try {
        const ticker = await FinanceService.syncTicker(symbols[i])
        synced++

        if (syncHistory) {
          try {
            const created = await FinanceService.syncHistoricalSnapshots(ticker)
            totalSnapshots += created
          } catch (err) {
            logger.warn('[FetchTicker] History sync failed for %s: %s', symbols[i], (err as Error).message)
          }
        }
      } catch (err) {
        logger.warn('[FetchTicker] Failed to sync %s: %s', symbols[i], (err as Error).message)
      }
      const pct = Math.round(((i + 1) / symbols.length) * 100)
      await job.updateProgress({ percent: pct, stage: 'Bulk sync', detail: `${synced}/${i + 1} synced (${symbols[i]})` })
    }

    logger.info('[FetchTicker] Bulk sync complete: %d/%d succeeded, %d snapshots', synced, symbols.length, totalSnapshots)
    return { synced, total: symbols.length, totalSnapshots }
  }

  // Single mode
  await job.updateProgress({ percent: 10, stage: 'Fetching quote', detail: symbol })
  logger.info('[FetchTicker] Syncing: %s', symbol)

  const ticker = await FinanceService.syncTicker(symbol)

  let snapshotsCreated = 0
  if (syncHistory !== false) {
    await job.updateProgress({ percent: 50, stage: 'Syncing history', detail: symbol })
    await new Promise((r) => setTimeout(r, 1000))
    snapshotsCreated = await FinanceService.syncHistoricalSnapshots(ticker)
  }

  await job.updateProgress({ percent: 100, stage: 'Complete', detail: `${symbol} $${ticker.currentPrice}` })

  logger.info(
    '[FetchTicker] %s synced. Price: %s, New snapshots: %d',
    symbol,
    ticker.currentPrice,
    snapshotsCreated
  )

  return {
    tickerId: ticker.id,
    symbol: ticker.symbol,
    price: ticker.currentPrice,
    snapshotsCreated,
  }
}

export async function queueAllTickerRefresh() {
  const tickers = await Ticker.query().where('is_active', true)
  const batchSize = 10
  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += batchSize) {
    batches.push(tickers.slice(i, i + batchSize).map((t) => t.symbol))
  }
  await QueueService.addBulk(
    QUEUE_NAMES.FETCH_TICKER,
    batches.map((symbols) => ({ data: { symbols, syncHistory: true } }))
  )
  logger.info('[FetchTicker] Queued %d tickers in %d batches for refresh', tickers.length, batches.length)
}

export function registerFetchTickerWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.FETCH_TICKER, processFetchTicker, 1)
}
