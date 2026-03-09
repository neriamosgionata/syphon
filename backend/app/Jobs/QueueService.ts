import { Queue, Worker, Job, QueueEvents } from 'bullmq'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'

export const QUEUE_NAMES = {
  SCRAPE_NEWS: 'scrape-news',
  ANALYZE_ARTICLE: 'analyze-article',
  FETCH_TICKER: 'fetch-ticker',
  SUBMIT_ORDER: 'submit-order',
  MONITOR_ORDER: 'monitor-order',
} as const

const connection = {
  host: Env.get('REDIS_HOST'),
  port: Env.get('REDIS_PORT'),
  password: Env.get('REDIS_PASSWORD', '') || undefined,
}

class QueueService {
  private queues: Map<string, Queue> = new Map()
  private workers: Map<string, Worker> = new Map()

  public getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      this.queues.set(name, new Queue(name, { connection }))
    }
    return this.queues.get(name)!
  }

  public registerWorker(
    name: string,
    processor: (job: Job) => Promise<any>,
    concurrency: number = 3
  ): Worker {
    const worker = new Worker(name, processor, {
      connection,
      concurrency,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    })

    worker.on('completed', (job) => {
      Logger.debug('[%s] Job %s completed', name, job.id)
    })

    worker.on('failed', (job, err) => {
      Logger.error('[%s] Job %s failed: %s', name, job?.id, err.message)
    })

    this.workers.set(name, worker)
    return worker
  }

  public async addJob(queueName: string, data: any, opts?: any) {
    const queue = this.getQueue(queueName)
    return queue.add(queueName, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      ...opts,
    })
  }

  public async addBulk(queueName: string, jobs: { data: any; opts?: any }[]) {
    const queue = this.getQueue(queueName)
    return queue.addBulk(
      jobs.map((j) => ({
        name: queueName,
        data: j.data,
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          ...j.opts,
        },
      }))
    )
  }

  public async getQueueStats(queueName: string) {
    const queue = this.getQueue(queueName)
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ])
    return { waiting, active, completed, failed, delayed }
  }

  public async getAllStats() {
    const stats: Record<string, any> = {}
    for (const name of Object.values(QUEUE_NAMES)) {
      stats[name] = await this.getQueueStats(name)
    }
    return stats
  }

  public async shutdown() {
    for (const [name, worker] of this.workers) {
      Logger.info('Shutting down worker: %s', name)
      await worker.close()
    }
    for (const [name, queue] of this.queues) {
      await queue.close()
    }
  }
}

export default new QueueService()
