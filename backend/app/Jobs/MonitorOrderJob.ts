import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import Trade from 'App/Models/Trade'
import NotificationService from 'App/Services/NotificationService'
import QueueService, { QUEUE_NAMES } from './QueueService'

const TERMINAL_STATUSES = ['filled', 'cancelled', 'error', 'inactive']
const MAX_MONITOR_ATTEMPTS = 720 // ~1 hour at 5s intervals

export async function processMonitorOrder(job: Job) {
  const { tradeId, attempt = 1 } = job.data

  const trade = await Trade.find(tradeId)
  if (!trade) return { done: true, reason: 'trade_not_found' }

  if (TERMINAL_STATUSES.includes(trade.status)) {
    Logger.info(
      '[MonitorOrder] Trade %d reached terminal status: %s',
      tradeId,
      trade.status,
    )

    NotificationService.emit({
      type: 'order_update',
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      status: trade.status,
      quantity: trade.quantity,
      fillPrice: trade.fillPrice,
      timestamp: new Date().toISOString(),
    })

    return { done: true, status: trade.status }
  }

  if (attempt >= MAX_MONITOR_ATTEMPTS) {
    Logger.warn('[MonitorOrder] Trade %d: max monitor attempts reached', tradeId)
    return { done: true, reason: 'max_attempts' }
  }

  // Re-queue for another check
  await QueueService.addJob(
    QUEUE_NAMES.MONITOR_ORDER,
    { tradeId, attempt: attempt + 1 },
    { delay: 5000 },
  )

  return { monitoring: true, attempt, status: trade.status }
}

export function registerMonitorOrderWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.MONITOR_ORDER, processMonitorOrder, 5)
}
