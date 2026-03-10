import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import FinanceService from 'App/Services/FinanceService'
import Ticker from 'App/Models/Ticker'
import QueueService, { QUEUE_NAMES } from './QueueService'

export async function processFetchTicker(job: Job) {
  const { symbol, symbols, syncHistory } = job.data

  // Bulk mode: sync many symbols in one job using batch API
  if (symbols && Array.isArray(symbols)) {
    await job.updateProgress({ percent: 0, stage: 'Bulk sync', detail: `0/${symbols.length} tickers` })
    Logger.info('[FetchTicker] Bulk syncing %d tickers', symbols.length)

    let synced = 0
    for (let i = 0; i < symbols.length; i++) {
      try {
        await FinanceService.syncTicker(symbols[i])
        synced++
      } catch (err) {
        Logger.warn('[FetchTicker] Failed to sync %s: %s', symbols[i], err.message)
      }
      const pct = Math.round(((i + 1) / symbols.length) * 100)
      await job.updateProgress({ percent: pct, stage: 'Bulk sync', detail: `${synced}/${i + 1} synced (${symbols[i]})` })
    }

    Logger.info('[FetchTicker] Bulk sync complete: %d/%d succeeded', synced, symbols.length)
    return { synced, total: symbols.length }
  }

  // Single mode
  await job.updateProgress({ percent: 10, stage: 'Fetching quote', detail: symbol })
  Logger.info('[FetchTicker] Syncing: %s', symbol)

  const ticker = await FinanceService.syncTicker(symbol)

  let snapshotsCreated = 0
  if (syncHistory !== false) {
    await job.updateProgress({ percent: 50, stage: 'Syncing history', detail: symbol })
    await new Promise((r) => setTimeout(r, 1000))
    snapshotsCreated = await FinanceService.syncHistoricalSnapshots(ticker, 90)
  }

  await job.updateProgress({ percent: 100, stage: 'Complete', detail: `${symbol} $${ticker.currentPrice}` })

  Logger.info(
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
  Logger.info('[FetchTicker] Queued %d tickers in %d batches for refresh', tickers.length, batches.length)
}

export function registerFetchTickerWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.FETCH_TICKER, processFetchTicker, 1)
}
