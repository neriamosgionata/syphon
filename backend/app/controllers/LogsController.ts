import type { HttpContext } from '@adonisjs/core/http'
import MeilisearchService from '#services/MeilisearchService'

export default class LogsController {
  public async index({ request }: HttpContext) {
    const params = request.qs()
    const result = await MeilisearchService.searchLogs({
      query: params.q || undefined,
      level: params.level || undefined,
      context: params.context || undefined,
      from: params.page ? (parseInt(params.page) - 1) * (parseInt(params.per_page) || 50) : 0,
      size: parseInt(params.per_page) || 50,
      dateFrom: params.date_from || undefined,
      dateTo: params.date_to || undefined,
    })

    return {
      total: result.total,
      logs: result.logs,
      page: parseInt(params.page) || 1,
      perPage: parseInt(params.per_page) || 50,
    }
  }

  public async stats({}: HttpContext) {
    try {
      // Meilisearch doesn't have aggregations like OpenSearch.
      // Get basic stats from the stats endpoint and recent logs for distribution.
      const stats = await MeilisearchService.getStats()
      const logsIndex = stats.indexes.find((i) => i.name === 'logs')

      // Fetch recent logs to compute level distribution
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
      const byLevel: { level: string; count: number }[] = []

      for (const level of levels) {
        const result = await MeilisearchService.searchLogs({ level, size: 0 })
        if (result.total > 0) {
          byLevel.push({ level, count: result.total })
        }
      }

      return {
        totalLogs: logsIndex?.docs || 0,
        byLevel,
        byContext: [],
        overTime: [],
        errorsOverTime: [],
      }
    } catch {
      return { totalLogs: 0, byLevel: [], byContext: [], overTime: [], errorsOverTime: [] }
    }
  }
}
