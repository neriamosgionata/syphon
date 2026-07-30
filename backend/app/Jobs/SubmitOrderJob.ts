import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import Trade from 'App/Models/Trade'
import IBKRService from 'App/Services/IBKRService'
import KrakenService from 'App/Services/KrakenService'
import BinanceService from 'App/Services/BinanceService'
import QueueService, { QUEUE_NAMES } from './QueueService'

export async function processSubmitOrder(job: Job) {
  const { tradeId } = job.data

  const trade = await Trade.find(tradeId)
  if (!trade) {
    Logger.warn('[SubmitOrder] Trade %d not found', tradeId)
    return { skipped: true }
  }

  if (trade.status !== 'pending') {
    Logger.debug('[SubmitOrder] Trade %d already in %s status', tradeId, trade.status)
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

  Logger.info(
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
