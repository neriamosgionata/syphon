import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import YahooFinanceService from 'App/Services/YahooFinanceService'
import Ticker from 'App/Models/Ticker'
import QueueService, { QUEUE_NAMES } from './QueueService'

export async function processFetchTicker(job: Job) {
  const { symbol, symbols, syncHistory } = job.data

  // Bulk mode: sync many symbols in one job using batch API
  if (symbols && Array.isArray(symbols)) {
    Logger.info('[FetchTicker] Bulk syncing %d tickers', symbols.length)
    const synced = await YahooFinanceService.syncTickersBulk(symbols, syncHistory !== false)
    Logger.info('[FetchTicker] Bulk sync complete: %d/%d succeeded', synced, symbols.length)
    return { synced, total: symbols.length }
  }

  // Single mode
  Logger.info('[FetchTicker] Syncing: %s', symbol)

  const ticker = await YahooFinanceService.syncTicker(symbol)

  let snapshotsCreated = 0
  if (syncHistory !== false) {
    await new Promise((r) => setTimeout(r, 1000))
    snapshotsCreated = await YahooFinanceService.syncHistoricalSnapshots(ticker, 90)
  }

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
  await QueueService.addBulk(
    QUEUE_NAMES.FETCH_TICKER,
    tickers.map((t) => ({ data: { symbol: t.symbol, syncHistory: true } }))
  )
  Logger.info('[FetchTicker] Queued %d tickers for refresh', tickers.length)
}

export function registerFetchTickerWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.FETCH_TICKER, processFetchTicker, 1)
}
