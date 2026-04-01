import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'
import Redis from '@ioc:Adonis/Addons/Redis'

const ARTICLES_INDEX = 'articles'
const LOGS_INDEX = 'logs'
const ANALYSES_INDEX = 'analyses'
const SNAPSHOTS_INDEX = 'snapshots'
const DECISIONS_INDEX = 'decisions'

class MeilisearchService {
  private baseUrl: string
  private apiKey: string

  constructor() {
    this.baseUrl = Env.get('MEILI_URL', 'http://localhost:7700')
    this.apiKey = Env.get('MEILI_KEY', '')
  }

  private async request(path: string, opts?: RequestInit): Promise<any> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(opts?.headers || {}),
      },
      ...opts,
    })
    if (resp.status === 204) return null
    const body = await resp.json().catch(() => null)
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Meilisearch ${resp.status}: ${body?.message || resp.statusText}`)
    }
    return body
  }

  private async createIndex(uid: string, primaryKey: string) {
    try {
      await this.request(`/indexes/${uid}`, {
        method: 'POST',
        body: JSON.stringify({ uid, primaryKey }),
      })
    } catch {
      // Index may already exist
    }
  }

  public async ensureIndex() {
    // ── Articles ──
    await this.createIndex(ARTICLES_INDEX, 'id')
    await this.request(`/indexes/${ARTICLES_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        searchableAttributes: ['title', 'summary', 'content', 'sourceName', 'author'],
        filterableAttributes: [
          'tickers', 'sentiment', 'sourceName', 'publishedAt',
          'isAnalyzed', 'externalId', 'url', 'scrapeSourceId', 'createdAt',
        ],
        sortableAttributes: ['publishedAt', 'createdAt', 'sentimentScore'],
        pagination: { maxTotalHits: 50000 },
      }),
    })

    // ── Logs ──
    await this.createIndex(LOGS_INDEX, 'id')
    await this.request(`/indexes/${LOGS_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        searchableAttributes: ['message', 'context'],
        filterableAttributes: ['level', 'context', 'timestamp'],
        sortableAttributes: ['timestamp'],
      }),
    })

    // ── Analyses ──
    await this.createIndex(ANALYSES_INDEX, 'id')
    await this.request(`/indexes/${ANALYSES_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        searchableAttributes: ['reasoning', 'tickerSymbol', 'sentiment'],
        filterableAttributes: [
          'articleId', 'tickerId', 'tickerSymbol', 'sentiment',
          'sentimentScore', 'createdAt',
        ],
        sortableAttributes: ['createdAt', 'sentimentScore', 'relevanceScore', 'confidence'],
        pagination: { maxTotalHits: 50000 },
      }),
    })

    // ── Snapshots ──
    await this.createIndex(SNAPSHOTS_INDEX, 'id')
    await this.request(`/indexes/${SNAPSHOTS_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        searchableAttributes: [],
        filterableAttributes: ['tickerId', 'tickerSymbol', 'date'],
        sortableAttributes: ['date', 'createdAt'],
        pagination: { maxTotalHits: 100000 },
      }),
    })

    // ── Decisions ──
    await this.createIndex(DECISIONS_INDEX, 'id')
    await this.request(`/indexes/${DECISIONS_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        searchableAttributes: ['reason', 'symbol'],
        filterableAttributes: [
          'runId', 'symbol', 'decision', 'tickerId', 'createdAt',
        ],
        sortableAttributes: ['createdAt', 'compositeScore'],
        pagination: { maxTotalHits: 50000 },
      }),
    })

    Logger.info('Meilisearch indexes ready')
  }

  // ════════════════════════════════════════════════════════════════
  //  ID Generation (Redis atomic counters)
  // ════════════════════════════════════════════════════════════════

  public async nextId(key: string): Promise<number> {
    return Redis.incr(`meili:id:${key}`)
  }

  // ════════════════════════════════════════════════════════════════
  //  Generic helpers
  // ════════════════════════════════════════════════════════════════

  private async indexDocs(index: string, docs: any[]) {
    if (docs.length === 0) return
    await this.request(`/indexes/${index}/documents`, {
      method: 'POST',
      body: JSON.stringify(docs),
    })
  }

  private async getDoc(index: string, id: string | number): Promise<any | null> {
    const doc = await this.request(`/indexes/${index}/documents/${id}`)
    return doc || null
  }

  private async deleteDocs(index: string, ids: (string | number)[]) {
    if (ids.length === 0) return
    await this.request(`/indexes/${index}/documents/delete-batch`, {
      method: 'POST',
      body: JSON.stringify(ids),
    })
  }

  private async deleteAllDocs(index: string) {
    await this.request(`/indexes/${index}/documents`, { method: 'DELETE' })
  }

  private async searchIndex(
    index: string,
    opts: {
      q?: string
      filter?: string | string[]
      sort?: string[]
      offset?: number
      limit?: number
    }
  ): Promise<{ hits: any[]; total: number }> {
    const body: any = {
      q: opts.q || '',
      offset: opts.offset || 0,
      limit: opts.limit || 20,
    }
    if (opts.filter) body.filter = opts.filter
    if (opts.sort) body.sort = opts.sort

    const result = await this.request(`/indexes/${index}/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    return {
      hits: result?.hits || [],
      total: result?.estimatedTotalHits || 0,
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  ARTICLES
  // ════════════════════════════════════════════════════════════════

  public async saveArticle(article: {
    externalId?: string | null
    title: string
    summary?: string | null
    content?: string | null
    url: string
    sourceName?: string | null
    scrapeSourceId?: number | null
    author?: string | null
    imageUrl?: string | null
    publishedAt?: string | null
    isAnalyzed?: boolean
  }): Promise<{ id: number }> {
    const id = await this.nextId('article')
    const now = new Date().toISOString()
    await this.indexDocs(ARTICLES_INDEX, [{
      id,
      ...article,
      isAnalyzed: article.isAnalyzed ?? false,
      createdAt: now,
      updatedAt: now,
    }])
    return { id }
  }

  public async getArticle(id: number): Promise<any | null> {
    return this.getDoc(ARTICLES_INDEX, id)
  }

  public async updateArticle(id: number, updates: Record<string, any>) {
    const existing = await this.getDoc(ARTICLES_INDEX, id)
    if (!existing) return
    await this.indexDocs(ARTICLES_INDEX, [{
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    }])
  }

  public async findArticleByExternalId(externalId: string): Promise<any | null> {
    const { hits } = await this.searchIndex(ARTICLES_INDEX, {
      filter: `externalId = "${externalId}"`,
      limit: 1,
    })
    return hits[0] || null
  }

  public async findArticleByUrl(url: string): Promise<any | null> {
    const { hits } = await this.searchIndex(ARTICLES_INDEX, {
      filter: `url = "${url}"`,
      limit: 1,
    })
    return hits[0] || null
  }

  public async getArticles(params: {
    page?: number
    limit?: number
    source?: string
    analyzed?: boolean
    sentiment?: string
    sort?: string
    dir?: 'asc' | 'desc'
  }): Promise<{ data: any[]; total: number; page: number; perPage: number; lastPage: number }> {
    const page = params.page || 1
    const limit = params.limit || 20
    const offset = (page - 1) * limit
    const filter: string[] = []

    if (params.source) filter.push(`sourceName = "${params.source}"`)
    if (params.analyzed !== undefined) filter.push(`isAnalyzed = ${params.analyzed}`)
    if (params.sentiment) filter.push(`sentiment = "${params.sentiment}"`)

    const sortField = params.sort || 'publishedAt'
    const sortDir = params.dir || 'desc'

    const { hits, total } = await this.searchIndex(ARTICLES_INDEX, {
      filter: filter.length > 0 ? filter : undefined,
      sort: [`${sortField}:${sortDir}`],
      offset,
      limit,
    })

    return {
      data: hits,
      total,
      page,
      perPage: limit,
      lastPage: Math.ceil(total / limit) || 1,
    }
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
    const filter: string[] = []

    if (params.ticker) filter.push(`tickers = "${params.ticker.toUpperCase()}"`)
    if (params.sentiment) filter.push(`sentiment = "${params.sentiment}"`)
    if (params.source) filter.push(`sourceName = "${params.source}"`)
    if (params.dateFrom) filter.push(`publishedAt >= "${params.dateFrom}"`)
    if (params.dateTo) filter.push(`publishedAt <= "${params.dateTo}"`)

    const { hits, total } = await this.searchIndex(ARTICLES_INDEX, {
      q: params.query,
      filter: filter.length > 0 ? filter : undefined,
      sort: ['publishedAt:desc'],
      offset: params.from || 0,
      limit: params.size || 20,
    })

    return {
      total,
      articles: hits.map((hit: any) => ({
        _score: hit._rankingScore || null,
        ...hit,
      })),
    }
  }

  public async getUnanalyzedArticles(limit: number = 50): Promise<any[]> {
    const { hits } = await this.searchIndex(ARTICLES_INDEX, {
      filter: 'isAnalyzed = false',
      sort: ['createdAt:desc'],
      limit,
    })
    return hits
  }

  public async countArticles(filter?: string): Promise<number> {
    const { total } = await this.searchIndex(ARTICLES_INDEX, {
      filter: filter || undefined,
      limit: 0,
    })
    return total
  }

  public async deleteArticle(id: number) {
    try {
      await this.request(`/indexes/${ARTICLES_INDEX}/documents/${id}`, { method: 'DELETE' })
    } catch {
      // ignore
    }
  }

  public async deleteAllArticles() {
    await this.deleteAllDocs(ARTICLES_INDEX)
  }

  // ════════════════════════════════════════════════════════════════
  //  ANALYSES
  // ════════════════════════════════════════════════════════════════

  public async saveAnalysis(analysis: {
    articleId: number
    tickerId: number
    tickerSymbol: string
    sentiment: string
    sentimentScore: number
    relevanceScore: number
    confidence: number
    keywords?: any
    reasoning?: string | null
    tickerPriceAtAnalysis?: number | null
  }): Promise<{ id: string }> {
    const id = `${analysis.articleId}_${analysis.tickerId}`
    const now = new Date().toISOString()
    await this.indexDocs(ANALYSES_INDEX, [{
      id,
      ...analysis,
      createdAt: now,
    }])
    return { id }
  }

  public async getAnalysis(id: string): Promise<any | null> {
    return this.getDoc(ANALYSES_INDEX, id)
  }

  public async findAnalysis(articleId: number, tickerId: number): Promise<any | null> {
    return this.getDoc(ANALYSES_INDEX, `${articleId}_${tickerId}`)
  }

  public async getAnalyses(params: {
    page?: number
    limit?: number
    tickerSymbol?: string
    sentiment?: string
    sort?: string
    dir?: 'asc' | 'desc'
  }): Promise<{ data: any[]; total: number; page: number; perPage: number; lastPage: number }> {
    const page = params.page || 1
    const limit = params.limit || 20
    const offset = (page - 1) * limit
    const filter: string[] = []

    if (params.tickerSymbol) filter.push(`tickerSymbol = "${params.tickerSymbol.toUpperCase()}"`)
    if (params.sentiment) filter.push(`sentiment = "${params.sentiment}"`)

    const sortField = params.sort || 'createdAt'
    const sortDir = params.dir || 'desc'

    const { hits, total } = await this.searchIndex(ANALYSES_INDEX, {
      filter: filter.length > 0 ? filter : undefined,
      sort: [`${sortField}:${sortDir}`],
      offset,
      limit,
    })

    return {
      data: hits,
      total,
      page,
      perPage: limit,
      lastPage: Math.ceil(total / limit) || 1,
    }
  }

  public async getAnalysesForTicker(tickerId: number, since?: string): Promise<any[]> {
    const filter: string[] = [`tickerId = ${tickerId}`]
    if (since) filter.push(`createdAt >= "${since}"`)

    const { hits } = await this.searchIndex(ANALYSES_INDEX, {
      filter,
      sort: ['createdAt:asc'],
      limit: 10000,
    })
    return hits
  }

  public async getRecentAnalyses(limit: number = 10): Promise<any[]> {
    const { hits } = await this.searchIndex(ANALYSES_INDEX, {
      sort: ['createdAt:desc'],
      limit,
    })
    return hits
  }

  public async countAnalyses(filter?: string): Promise<number> {
    const { total } = await this.searchIndex(ANALYSES_INDEX, {
      filter: filter || undefined,
      limit: 0,
    })
    return total
  }

  public async deleteAllAnalyses() {
    await this.deleteAllDocs(ANALYSES_INDEX)
  }

  // ════════════════════════════════════════════════════════════════
  //  SNAPSHOTS
  // ════════════════════════════════════════════════════════════════

  public async saveSnapshot(snapshot: {
    tickerId: number
    tickerSymbol: string
    open: number | null
    high: number | null
    low: number | null
    close: number | null
    volume: number | null
    changePercent: number | null
    date: string
  }): Promise<{ id: string }> {
    const id = `${snapshot.tickerId}_${snapshot.date}`
    await this.indexDocs(SNAPSHOTS_INDEX, [{
      id,
      ...snapshot,
      createdAt: new Date().toISOString(),
    }])
    return { id }
  }

  public async saveSnapshots(snapshots: any[]) {
    if (snapshots.length === 0) return
    const docs = snapshots.map((s) => ({
      id: `${s.tickerId}_${s.date}`,
      ...s,
      createdAt: s.createdAt || new Date().toISOString(),
    }))
    // Batch in chunks of 1000
    for (let i = 0; i < docs.length; i += 1000) {
      await this.indexDocs(SNAPSHOTS_INDEX, docs.slice(i, i + 1000))
    }
  }

  public async getSnapshot(tickerId: number, date: string): Promise<any | null> {
    return this.getDoc(SNAPSHOTS_INDEX, `${tickerId}_${date}`)
  }

  public async getSnapshotsForTicker(tickerId: number): Promise<any[]> {
    const { hits } = await this.searchIndex(SNAPSHOTS_INDEX, {
      filter: `tickerId = ${tickerId}`,
      sort: ['date:asc'],
      limit: 10000,
    })
    return hits
  }

  public async getSnapshotsForTickers(tickerIds: number[]): Promise<any[]> {
    if (tickerIds.length === 0) return []
    const idList = tickerIds.join(', ')
    const { hits } = await this.searchIndex(SNAPSHOTS_INDEX, {
      filter: `tickerId IN [${idList}]`,
      sort: ['date:asc'],
      limit: 100000,
    })
    return hits
  }

  public async deleteAllSnapshots() {
    await this.deleteAllDocs(SNAPSHOTS_INDEX)
  }

  // ════════════════════════════════════════════════════════════════
  //  DECISIONS
  // ════════════════════════════════════════════════════════════════

  public async saveDecision(decision: {
    runId: string
    symbol: string
    tickerId: number
    decision: string
    reason: string
    side?: string | null
    quantity?: number | null
    compositeScore?: number | null
    conviction?: number | null
    regime?: string | null
    positionSizePct?: number | null
    stopLoss?: number | null
    takeProfit?: number | null
    tradeId?: number | null
    algoPositionId?: number | null
    context?: any
  }): Promise<{ id: number }> {
    const id = await this.nextId('decision')
    await this.indexDocs(DECISIONS_INDEX, [{
      id,
      ...decision,
      createdAt: new Date().toISOString(),
    }])
    return { id }
  }

  public async getDecisions(params: {
    page?: number
    limit?: number
    runId?: string
    symbol?: string
    decision?: string
  }): Promise<{ data: any[]; total: number; page: number; perPage: number; lastPage: number }> {
    const page = params.page || 1
    const limit = params.limit || 50
    const offset = (page - 1) * limit
    const filter: string[] = []

    if (params.runId) filter.push(`runId = "${params.runId}"`)
    if (params.symbol) filter.push(`symbol = "${params.symbol.toUpperCase()}"`)
    if (params.decision) filter.push(`decision = "${params.decision}"`)

    const { hits, total } = await this.searchIndex(DECISIONS_INDEX, {
      filter: filter.length > 0 ? filter : undefined,
      sort: ['createdAt:desc'],
      offset,
      limit,
    })

    return {
      data: hits,
      total,
      page,
      perPage: limit,
      lastPage: Math.ceil(total / limit) || 1,
    }
  }

  public async countDistinctRuns(): Promise<number> {
    // Fetch all decisions and count unique runIds
    const { hits } = await this.searchIndex(DECISIONS_INDEX, {
      sort: ['createdAt:desc'],
      limit: 50000,
    })
    const runIds = new Set(hits.map((h: any) => h.runId))
    return runIds.size
  }

  public async deleteAllDecisions() {
    await this.deleteAllDocs(DECISIONS_INDEX)
  }

  // ════════════════════════════════════════════════════════════════
  //  LOGS (unchanged)
  // ════════════════════════════════════════════════════════════════

  private logBuffer: any[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private logCounter = 0

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
    this.logCounter++
    this.logBuffer.push({ id: `${Date.now()}-${this.logCounter}`, ...entry })
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
    try {
      await this.indexDocs(LOGS_INDEX, entries)
    } catch {
      // Don't log errors about logging
    }
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
    const filter: string[] = []

    if (params.level) filter.push(`level = "${params.level}"`)
    if (params.context) filter.push(`context = "${params.context}"`)
    if (params.dateFrom) filter.push(`timestamp >= "${params.dateFrom}"`)
    if (params.dateTo) filter.push(`timestamp <= "${params.dateTo}"`)

    const { hits, total } = await this.searchIndex(LOGS_INDEX, {
      q: params.query,
      filter: filter.length > 0 ? filter : undefined,
      sort: ['timestamp:desc'],
      offset: params.from || 0,
      limit: params.size || 50,
    })

    return { total, logs: hits }
  }

  public async deleteAllLogs() {
    await this.deleteAllDocs(LOGS_INDEX)
  }

  // ════════════════════════════════════════════════════════════════
  //  STATS (for metrics)
  // ════════════════════════════════════════════════════════════════

  public async getStats(): Promise<{ indexes: any[]; totalDocs: number }> {
    try {
      const stats = await this.request('/stats')
      let totalDocs = 0
      const indexes = Object.entries(stats?.indexes || {}).map(([name, data]: [string, any]) => {
        totalDocs += data.numberOfDocuments || 0
        return {
          name,
          docs: data.numberOfDocuments || 0,
          isIndexing: data.isIndexing || false,
        }
      })
      return { indexes, totalDocs }
    } catch {
      return { indexes: [], totalDocs: 0 }
    }
  }
}

export default new MeilisearchService()
