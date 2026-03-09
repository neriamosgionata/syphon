import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import OpenSearchService from 'App/Services/OpenSearchService'

export default class LogsController {
  public async index({ request }: HttpContextContract) {
    const params = request.qs()
    const result = await OpenSearchService.searchLogs({
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

  public async stats({}: HttpContextContract) {
    const client = await OpenSearchService.getClient()

    try {
      const result = await client.search({
        index: 'syphon-logs',
        body: {
          size: 0,
          aggs: {
            by_level: { terms: { field: 'level', size: 10 } },
            by_context: { terms: { field: 'context', size: 20 } },
            over_time: {
              date_histogram: {
                field: 'timestamp',
                fixed_interval: '1h',
              },
            },
            errors_over_time: {
              filter: { terms: { level: ['error', 'fatal'] } },
              aggs: {
                over_time: {
                  date_histogram: {
                    field: 'timestamp',
                    fixed_interval: '1h',
                  },
                },
              },
            },
          },
        },
      })

      const aggs = result.body.aggregations

      return {
        totalLogs: result.body.hits.total.value,
        byLevel: aggs.by_level.buckets.map((b: any) => ({ level: b.key, count: b.doc_count })),
        byContext: aggs.by_context.buckets.map((b: any) => ({ context: b.key, count: b.doc_count })),
        overTime: aggs.over_time.buckets.map((b: any) => ({ time: b.key_as_string, count: b.doc_count })),
        errorsOverTime: aggs.errors_over_time.over_time.buckets.map((b: any) => ({ time: b.key_as_string, count: b.doc_count })),
      }
    } catch {
      return { totalLogs: 0, byLevel: [], byContext: [], overTime: [], errorsOverTime: [] }
    }
  }
}
