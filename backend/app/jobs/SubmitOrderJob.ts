import { Job } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import Trade from '#models/Trade'
import IBKRService from '#services/IBKRService'
import KrakenService from '#services/KrakenService'
import BinanceService from '#services/BinanceService'
import QueueService, { QUEUE_NAMES } from './QueueService.js'

export async function processSubmitOrder(job: Job) {
  const { tradeId } = job.data

  const trade = await Trade.find(tradeId)
  if (!trade) {
    logger.warn('[SubmitOrder] Trade %d not found', tradeId)
    return { skipped: true }
  }

  if (trade.status !== 'pending') {
    logger.debug('[SubmitOrder] Trade %d already in %s status', tradeId, trade.status)
    return { skipped: true }
  }

  await job.updateProgress({ percent: 30, stage: 'Submitting', detail: `${trade.side} ${trade.quantity} ${trade.symbol} (${trade.broker})` })

  let result: Trade

  if (trade.broker === 'kraken') {
    result = await KrakenService.placeOrderAny(trade)
  } else if (trade.broker === 'binance') {
    result = await BinanceService.placeOrder(trade)
  } else {
    result = await IBKRService.placeOrder(trade)
  }

  await job.updateProgress({ percent: 100, stage: 'Submitted', detail: `Status: ${result.status}` })

  logger.info(
    '[SubmitOrder] Trade %d [%s]: %s %d %s -> status=%s',
    trade.id,
    trade.broker,
    trade.side,
    trade.quantity,
    trade.symbol,
    result.status,
  )

  // If order was submitted successfully, schedule a status check
  if (result.status === 'submitted' || result.status === 'pre_submitted') {
    await QueueService.addJob(
      QUEUE_NAMES.MONITOR_ORDER,
      { tradeId: trade.id },
      { delay: trade.broker === 'kraken' ? 3000 : 5000 },
    )
  }

  return {
    tradeId: trade.id,
    status: result.status,
    externalOrderId: result.externalOrderId || result.ibOrderId,
  }
}

export function registerSubmitOrderWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.SUBMIT_ORDER, processSubmitOrder, 2)
}
