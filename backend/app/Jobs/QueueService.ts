import { Queue, Worker, Job, QueueEvents } from 'bullmq'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'
import NotificationService from 'App/Services/NotificationService'

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
      NotificationService.emit({
        type: 'job_finished',
        queue: name,
        jobId: job.id!,
        status: 'completed',
        result: job.returnvalue,
        timestamp: new Date().toISOString(),
      })
    })

    worker.on('failed', (job, err) => {
      Logger.error('[%s] Job %s failed: %s', name, job?.id, err.message)
      if (job) {
        NotificationService.emit({
          type: 'job_finished',
          queue: name,
          jobId: job.id!,
          status: 'failed',
          error: err.message,
          timestamp: new Date().toISOString(),
        })
      }
    })

    worker.on('progress', (job, progress) => {
      const p = typeof progress === 'object' ? progress : { progress, stage: '' }
      NotificationService.emit({
        type: 'job_progress',
        queue: name,
        jobId: job.id!,
        progress: p.percent ?? p.progress ?? 0,
        stage: p.stage || '',
        detail: p.detail || undefined,
        timestamp: new Date().toISOString(),
      })
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

  public async getActiveJobs() {
    const jobs: any[] = []
    for (const name of Object.values(QUEUE_NAMES)) {
      const queue = this.getQueue(name)
      const [active, waiting, delayed] = await Promise.all([
        queue.getJobs(['active'], 0, 20),
        queue.getJobs(['waiting'], 0, 20),
        queue.getJobs(['delayed'], 0, 10),
      ])
      for (const job of [...active, ...waiting, ...delayed]) {
        const state = await job.getState()
        const progress = job.progress
        const p = typeof progress === 'object' ? progress : { percent: progress || 0, stage: '' }
        jobs.push({
          id: job.id,
          queue: name,
          state,
          data: job.data,
          progress: p.percent ?? p.progress ?? 0,
          stage: p.stage || '',
          detail: p.detail || '',
          timestamp: job.timestamp,
          processedOn: job.processedOn || null,
          attemptsMade: job.attemptsMade,
        })
      }
    }
    // Sort: active first, then waiting, then delayed; within each group by timestamp
    const stateOrder: Record<string, number> = { active: 0, waiting: 1, delayed: 2 }
    jobs.sort((a, b) => (stateOrder[a.state] ?? 3) - (stateOrder[b.state] ?? 3) || a.timestamp - b.timestamp)
    return jobs
  }

  public async getFailedJobs(limit: number = 50) {
    const jobs: any[] = []
    for (const name of Object.values(QUEUE_NAMES)) {
      const queue = this.getQueue(name)
      const failed = await queue.getJobs(['failed'], 0, limit)
      for (const job of failed) {
        jobs.push({
          id: job.id,
          queue: name,
          data: job.data,
          failedReason: job.failedReason || 'Unknown error',
          stacktrace: (job.stacktrace || []).slice(0, 3),
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
          processedOn: job.processedOn || null,
          finishedOn: job.finishedOn || null,
        })
      }
    }
    jobs.sort((a, b) => (b.finishedOn || b.timestamp) - (a.finishedOn || a.timestamp))
    return jobs.slice(0, limit)
  }

  public async retryJob(queueName: string, jobId: string) {
    const queue = this.getQueue(queueName)
    const job = await queue.getJob(jobId)
    if (!job) return false
    await job.retry()
    return true
  }

  public async removeFailedJob(queueName: string, jobId: string) {
    const queue = this.getQueue(queueName)
    const job = await queue.getJob(jobId)
    if (!job) return false
    await job.remove()
    return true
  }

  public async drainAll() {
    for (const name of Object.values(QUEUE_NAMES)) {
      const queue = this.getQueue(name)
      await queue.drain()
      await queue.clean(0, 0, 'completed')
      await queue.clean(0, 0, 'failed')
    }
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
