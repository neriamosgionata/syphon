import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import QueueService from '#jobs/QueueService'
import MeilisearchService from '#services/MeilisearchService'

export default class MetricsController {
  public async index({ response }: HttpContext) {
    const [system, database, redis, meilisearch, queues, services] = await Promise.all([
      this.getSystemMetrics(),
      this.getDatabaseMetrics(),
      this.getRedisMetrics(),
      this.getMeilisearchMetrics(),
      this.getQueueMetrics(),
      this.getServiceHealth(),
    ])

    return response.json({
      system,
      database,
      redis,
      meilisearch,
      queues,
      services,
      timestamp: new Date().toISOString(),
    })
  }

  private getSystemMetrics() {
    const mem = process.memoryUsage()
    const cpuUsage = process.cpuUsage()
    return {
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers || 0,
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
      },
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
    }
  }

  private async getDatabaseMetrics() {
    try {
      // db.connection() returns a QueryClient — dialect info lives on
      // .dialect.name ('better-sqlite3' for the better-sqlite3 client).
      const isSqlite = db.connection().dialect.name === 'better-sqlite3'
      let tables: any[]
      let totalSize = 0
      let totalRows = 0

      if (isSqlite) {
        const [pageCountRes, pageSizeRes] = await Promise.all([
          db.rawQuery('PRAGMA page_count'),
          db.rawQuery('PRAGMA page_size'),
        ])
        const pageCount = Number(pageCountRes[0]?.page_count ?? pageCountRes[0]?.c ?? 0)
        const pageSize = Number(pageSizeRes[0]?.page_size ?? pageSizeRes[0]?.c ?? 0)
        totalSize = pageCount * pageSize

        const tableRes = await db.rawQuery(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        const tableNames = tableRes.map((row: any) => row.name)
        const counts = await Promise.all(
          tableNames.map((name: string) =>
            db.rawQuery(`SELECT COUNT(*) as cnt FROM "${name}"`)
          )
        )
        tables = tableNames.map((name: string, i: number) => {
          const rows = Number(counts[i][0]?.cnt ?? 0)
          totalRows += rows
          return { name, rows, dataSize: 0, indexSize: 0, totalSize: 0 }
        })
      } else {
        const result = await db.rawQuery('SHOW TABLE STATUS')
        tables = (result[0] || []).map((row: any) => ({
          name: row.Name,
          rows: Number(row.Rows || 0),
          dataSize: Number(row.Data_length || 0),
          indexSize: Number(row.Index_length || 0),
          totalSize: Number(row.Data_length || 0) + Number(row.Index_length || 0),
        }))
        totalSize = tables.reduce((sum: number, t: any) => sum + t.totalSize, 0)
        totalRows = tables.reduce((sum: number, t: any) => sum + t.rows, 0)
      }

      return { tables, totalSize, totalRows }
    } catch (err) {
      logger.error('[Metrics] db metrics error: %s', (err as Error).message)
      return { tables: [], totalSize: 0, totalRows: 0, error: (err as Error).message }
    }
  }

  private async getRedisMetrics() {
    try {
      const info = await redis.connection().info()
      const lines = info.split('\r\n')
      const parsed: Record<string, string> = {}
      for (const line of lines) {
        const [key, val] = line.split(':')
        if (key && val) parsed[key] = val
      }

      return {
        usedMemory: Number(parsed['used_memory'] || 0),
        usedMemoryHuman: parsed['used_memory_human'] || '0B',
        usedMemoryPeak: Number(parsed['used_memory_peak'] || 0),
        totalKeys: Number(parsed['db0']?.match(/keys=(\d+)/)?.[1] || 0),
        connectedClients: Number(parsed['connected_clients'] || 0),
        uptimeSeconds: Number(parsed['uptime_in_seconds'] || 0),
        version: parsed['redis_version'] || 'unknown',
      }
    } catch (err) {
      logger.error('[Metrics] redis metrics error: %s', (err as Error).message)
      return { usedMemory: 0, usedMemoryHuman: '0B', error: (err as Error).message }
    }
  }

  private async getMeilisearchMetrics() {
    try {
      const stats = await MeilisearchService.getStats()
      const totalDocs = stats.indexes.reduce((sum: number, i: any) => sum + i.docs, 0)
      return { indexes: stats.indexes, totalDocs }
    } catch (err) {
      logger.error('[Metrics] Meilisearch metrics error: %s', (err as Error).message)
      return { indexes: [], totalDocs: 0, error: (err as Error).message }
    }
  }

  private async getQueueMetrics() {
    try {
      const stats = await QueueService.getAllStats()
      let totalActive = 0
      let totalWaiting = 0
      let totalCompleted = 0
      let totalFailed = 0

      for (const q of Object.values(stats) as any[]) {
        totalActive += q.active || 0
        totalWaiting += q.waiting || 0
        totalCompleted += q.completed || 0
        totalFailed += q.failed || 0
      }

      return {
        queues: stats,
        totals: { active: totalActive, waiting: totalWaiting, completed: totalCompleted, failed: totalFailed },
      }
    } catch (err) {
      logger.error('[Metrics] Queue metrics error: %s', (err as Error).message)
      return { queues: {}, totals: { active: 0, waiting: 0, completed: 0, failed: 0 }, error: (err as Error).message }
    }
  }

  private async getServiceHealth() {
    const checks = await Promise.allSettled([
      this.checkMySQL(),
      this.checkRedis(),
      this.checkMeilisearch(),
      this.checkTrainingAPI(),
    ])

    return {
      mysql: checks[0].status === 'fulfilled' ? checks[0].value : { status: 'error', error: (checks[0] as any).reason?.message },
      redis: checks[1].status === 'fulfilled' ? checks[1].value : { status: 'error', error: (checks[1] as any).reason?.message },
      meilisearch: checks[2].status === 'fulfilled' ? checks[2].value : { status: 'error', error: (checks[2] as any).reason?.message },
      training: checks[3].status === 'fulfilled' ? checks[3].value : { status: 'error', error: (checks[3] as any).reason?.message },
    }
  }

  private async checkMySQL() {
    const start = Date.now()
    await db.rawQuery('SELECT 1')
    return { status: 'ok', latencyMs: Date.now() - start }
  }

  private async checkRedis() {
    const start = Date.now()
    await redis.connection().ping()
    return { status: 'ok', latencyMs: Date.now() - start }
  }

  private async checkMeilisearch() {
    const start = Date.now()
    const url = env.get('MEILI_URL', 'http://localhost:7700')
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
    const data: any = await resp.json()
    return { status: data.status === 'available' ? 'ok' : 'degraded', latencyMs: Date.now() - start }
  }

  private async checkTrainingAPI() {
    const url = env.get('TRAINING_API_URL', '')
    if (!url) return { status: 'not_configured' }

    const start = Date.now()
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
    const data: any = await resp.json()
    return {
      status: data.status === 'ok' ? 'ok' : 'degraded',
      latencyMs: Date.now() - start,
      modelLoaded: data.model_loaded,
    }
  }
}
