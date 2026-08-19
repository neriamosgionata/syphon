import { Job } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import AlgoTradingService from '#services/AlgoTradingService'
import QueueService, { QUEUE_NAMES } from './QueueService.js'

export async function processAlgoTrading(job: Job) {
  logger.info('[AlgoTrading] Starting algo run (job %s)', job.id)

  const service = new AlgoTradingService()

  const result = await service.run(async (pct, stage, detail) => {
    await job.updateProgress({ percent: pct, stage, detail })
  })

  logger.info(
    '[AlgoTrading] Run %s complete: %d entries, %d exits, %d holds, %d skips (dryRun=%s, %dms)',
    result.runId,
    result.decisionsEnter,
    result.decisionsExit,
    result.decisionsHold,
    result.decisionsSkip,
    result.dryRun,
    result.durationMs
  )

  // Reconcile pending position fills
  await service.reconcilePositions()

  return result
}

export function registerAlgoTradingWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.ALGO_TRADING, processAlgoTrading, 1)
}
