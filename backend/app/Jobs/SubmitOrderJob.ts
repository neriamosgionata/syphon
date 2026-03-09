import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import Trade from 'App/Models/Trade'
import IBKRService from 'App/Services/IBKRService'
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

  const result = await IBKRService.placeOrder(trade)

  Logger.info(
    '[SubmitOrder] Trade %d: %s %d %s -> status=%s (ibOrderId=%d)',
    trade.id,
    trade.side,
    trade.quantity,
    trade.symbol,
    result.status,
    result.ibOrderId,
  )

  // If order was submitted successfully, schedule a status check
  if (result.status === 'submitted' || result.status === 'pre_submitted') {
    await QueueService.addJob(
      QUEUE_NAMES.MONITOR_ORDER,
      { tradeId: trade.id },
      { delay: 5000 },
    )
  }

  return {
    tradeId: trade.id,
    status: result.status,
    ibOrderId: result.ibOrderId,
  }
}

export function registerSubmitOrderWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.SUBMIT_ORDER, processSubmitOrder, 2)
}
