import { Job } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import Trade from '#models/Trade'
import KrakenService from '#services/KrakenService'
import BinanceService from '#services/BinanceService'
import NotificationService from '#services/NotificationService'
import QueueService, { QUEUE_NAMES } from './QueueService.js'

const TERMINAL_STATUSES = ['filled', 'cancelled', 'error', 'inactive']
const MAX_MONITOR_ATTEMPTS = 720 // ~1 hour at 5s intervals

export async function processMonitorOrder(job: Job) {
  const { tradeId, attempt = 1 } = job.data

  const trade = await Trade.find(tradeId)
  if (!trade) return { done: true, reason: 'trade_not_found' }

  // For non-IBKR trades, actively poll order status since there are no socket callbacks
  if (trade.broker === 'kraken' && !TERMINAL_STATUSES.includes(trade.status)) {
    await KrakenService.syncOrderStatusAny(trade)
  }
  if (trade.broker === 'binance' && !TERMINAL_STATUSES.includes(trade.status)) {
    await BinanceService.syncOrderStatus(trade)
  }

  if (TERMINAL_STATUSES.includes(trade.status)) {
    logger.info(
      '[MonitorOrder] Trade %d [%s] reached terminal status: %s',
      tradeId,
      trade.broker,
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
    logger.warn('[MonitorOrder] Trade %d: max monitor attempts reached', tradeId)
    return { done: true, reason: 'max_attempts' }
  }

  // Re-queue for another check (REST-based brokers poll faster since it's REST-based)
  const delay = (trade.broker === 'kraken' || trade.broker === 'binance') ? 3000 : 5000

  await QueueService.addJob(
    QUEUE_NAMES.MONITOR_ORDER,
    { tradeId, attempt: attempt + 1 },
    { delay },
  )

  return { monitoring: true, attempt, status: trade.status }
}

export function registerMonitorOrderWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.MONITOR_ORDER, processMonitorOrder, 5)
}
