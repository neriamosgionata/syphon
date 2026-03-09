import { Client } from '@opensearch-project/opensearch'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'

const ARTICLES_INDEX = 'syphon-articles'
const LOGS_INDEX = 'syphon-logs'

const logsMapping = {
  properties: {
    timestamp: { type: 'date' },
    level: { type: 'keyword' },
    levelNumber: { type: 'integer' },
    message: { type: 'text' },
    context: { type: 'keyword' },
    hostname: { type: 'keyword' },
    pid: { type: 'integer' },
    data: { type: 'object', enabled: false },
  },
}

const articleMapping = {
  properties: {
    id: { type: 'integer' },
    title: { type: 'text', analyzer: 'standard' },
    summary: { type: 'text', analyzer: 'standard' },
    content: { type: 'text', analyzer: 'standard' },
    url: { type: 'keyword' },
    source_name: { type: 'keyword' },
    author: { type: 'keyword' },
    published_at: { type: 'date' },
    tickers: { type: 'keyword' },
    sentiment: { type: 'keyword' },
    sentiment_score: { type: 'float' },
    created_at: { type: 'date' },
  },
}

class OpenSearchService {
  private client: Client

  constructor() {
    this.client = new Client({
      node: Env.get('OPENSEARCH_NODE'),
    })
  }

  public async ensureIndex() {
    const articlesExists = await this.client.indices.exists({ index: ARTICLES_INDEX })
    if (!articlesExists.body) {
      await this.client.indices.create({
        index: ARTICLES_INDEX,
        body: { mappings: articleMapping },
      })
      Logger.info('Created OpenSearch index: %s', ARTICLES_INDEX)
    }

    const logsExists = await this.client.indices.exists({ index: LOGS_INDEX })
    if (!logsExists.body) {
      await this.client.indices.create({
        index: LOGS_INDEX,
        body: { mappings: logsMapping },
      })
      Logger.info('Created OpenSearch index: %s', LOGS_INDEX)
    }
  }

  public async indexArticle(article: {
    id: number
    title: string
    summary?: string | null
    content?: string | null
    url: string
    source_name: string
    author?: string | null
    published_at?: string | null
    tickers?: string[]
    sentiment?: string | null
    sentiment_score?: number | null
  }) {
    await this.client.index({
      index: ARTICLES_INDEX,
      id: String(article.id),
      body: article,
      refresh: true,
    })
  }

  public async searchArticles(params: {
    query?: string
    ticker?: string
    sentiment?: string
    source?: string
    from?: number
    size?: number
    dateFrom?: string
    dateTo?: string
  }) {
    const must: any[] = []
    const filter: any[] = []

    if (params.query) {
      must.push({
        multi_match: {
          query: params.query,
          fields: ['title^3', 'summary^2', 'content'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      })
    }

    if (params.ticker) {
      filter.push({ term: { tickers: params.ticker.toUpperCase() } })
    }

    if (params.sentiment) {
      filter.push({ term: { sentiment: params.sentiment } })
    }

    if (params.source) {
      filter.push({ term: { source_name: params.source } })
    }

    if (params.dateFrom || params.dateTo) {
      const range: any = {}
      if (params.dateFrom) range.gte = params.dateFrom
      if (params.dateTo) range.lte = params.dateTo
      filter.push({ range: { published_at: range } })
    }

    const body: any = {
      from: params.from || 0,
      size: params.size || 20,
      sort: [{ published_at: { order: 'desc' } }],
    }

    if (must.length > 0 || filter.length > 0) {
      body.query = {
        bool: {
          ...(must.length > 0 ? { must } : { must: [{ match_all: {} }] }),
          ...(filter.length > 0 ? { filter } : {}),
        },
      }
    } else {
      body.query = { match_all: {} }
    }

    const result = await this.client.search({
      index: ARTICLES_INDEX,
      body,
    })

    return {
      total: result.body.hits.total.value,
      articles: result.body.hits.hits.map((hit: any) => ({
        _score: hit._score,
        ...hit._source,
      })),
    }
  }

  public async deleteArticle(id: number) {
    try {
      await this.client.delete({ index: ARTICLES_INDEX, id: String(id) })
    } catch {
      // ignore if not found
    }
  }

  // --- Log ingestion ---
  private logBuffer: any[] = []
  private flushTimer: NodeJS.Timeout | null = null

  public pushLog(entry: {
    timestamp: string
    level: string
    levelNumber: number
    message: string
    context?: string
    hostname?: string
    pid?: number
    data?: any
  }) {
    this.logBuffer.push(entry)
    if (this.logBuffer.length >= 50) {
      this.flushLogs()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushLogs(), 5000)
    }
  }

  private async flushLogs() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.logBuffer.length === 0) return

    const entries = this.logBuffer.splice(0)
    const body: any[] = []
    for (const entry of entries) {
      body.push({ index: { _index: LOGS_INDEX } })
      body.push(entry)
    }

    try {
      await this.client.bulk({ body })
    } catch {
      // Don't log errors about logging to avoid infinite loops
    }
  }

  public async getClient() {
    return this.client
  }

  public async searchLogs(params: {
    query?: string
    level?: string
    context?: string
    from?: number
    size?: number
    dateFrom?: string
    dateTo?: string
  }) {
    const must: any[] = []
    const filter: any[] = []

    if (params.query) {
      must.push({ match: { message: { query: params.query, fuzziness: 'AUTO' } } })
    }

    if (params.level) {
      filter.push({ term: { level: params.level } })
    }

    if (params.context) {
      filter.push({ term: { context: params.context } })
    }

    if (params.dateFrom || params.dateTo) {
      const range: any = {}
      if (params.dateFrom) range.gte = params.dateFrom
      if (params.dateTo) range.lte = params.dateTo
      filter.push({ range: { timestamp: range } })
    }

    const body: any = {
      from: params.from || 0,
      size: params.size || 50,
      sort: [{ timestamp: { order: 'desc' } }],
    }

    if (must.length > 0 || filter.length > 0) {
      body.query = {
        bool: {
          ...(must.length > 0 ? { must } : { must: [{ match_all: {} }] }),
          ...(filter.length > 0 ? { filter } : {}),
        },
      }
    } else {
      body.query = { match_all: {} }
    }

    const result = await this.client.search({ index: LOGS_INDEX, body })

    return {
      total: result.body.hits.total.value,
      logs: result.body.hits.hits.map((hit: any) => hit._source),
    }
  }
}

export default new OpenSearchService()
