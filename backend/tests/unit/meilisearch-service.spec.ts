import { test } from '@japa/runner'
import { installIocHooks, restoreIocHooks, createRedisStub } from './helpers/ioc-hooks'

// MeilisearchService unit tests with a stubbed Redis counter and a captured
// global fetch. These lock in the behaviors that were fixed: 404 -> null,
// numeric coercion of pagination params, log buffering and snapshot chunking.

let Meili: any
let originalIocHooks: any = null
let fetchCalls: Array<{ url: string; init: any }> = []
let redisStub: any

function stubFetch(handler: (url: string, init: any) => any) {
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    fetchCalls.push({ url, init })
    return handler(url, init)
  }
}

function jsonResponse(body: any, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
}

test.group('MeilisearchService', (group) => {
  let originalFetch: any

  group.setup(async () => {
    const { Application } = await import('@adonisjs/application')
    const app = new Application(__dirname, 'test', {})

    app.container.singleton('Adonis/Core/Logger', () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }))

    app.container.singleton('Adonis/Core/Env', () => ({
      get: (key: string, defaultVal?: any) => {
        const vals: Record<string, any> = {
          MEILI_URL: process.env.MEILI_URL || 'http://localhost:7700',
          MEILI_KEY: process.env.MEILI_KEY || '',
        }
        return vals[key] ?? defaultVal ?? ''
      },
    }))

    redisStub = createRedisStub()
    app.container.singleton('Adonis/Addons/Redis', () => redisStub)

    originalIocHooks = installIocHooks(app)

    Meili = (await import('../../app/Services/MeilisearchService')).default
    originalFetch = globalThis.fetch
  })

  group.teardown(() => restoreIocHooks(originalIocHooks))

  group.each.setup(() => {
    fetchCalls = []
    redisStub.counters.clear()
    Meili['logBuffer'] = []
    if (Meili['flushTimer']) {
      clearTimeout(Meili['flushTimer'])
      Meili['flushTimer'] = null
    }
  })

  group.each.teardown(() => {
    ;(globalThis as any).fetch = originalFetch
  })

  test('nextId increments through Redis', async ({ assert }) => {
    const a = await Meili.nextId('article')
    const b = await Meili.nextId('article')
    const c = await Meili.nextId('article')
    assert.equal(a, 1)
    assert.equal(b, 2)
    assert.equal(c, 3)
  })

  test('saveArticle assigns an id and createdAt/updatedAt', async ({ assert }) => {
    stubFetch(() => jsonResponse(null, 204))
    const saved = await Meili.saveArticle({ title: 'Test', url: 'https://example.com/x', isAnalyzed: true })

    assert.equal(saved.id, 1)
    assert.equal(fetchCalls.length, 1)
    assert.match(fetchCalls[0].url, /indexes\/articles\/documents$/)
    const doc = JSON.parse(fetchCalls[0].init.body)[0]
    assert.equal(doc.title, 'Test')
    assert.equal(doc.id, 1)
    assert.isTrue(doc.isAnalyzed)
    assert.isString(doc.createdAt)
    assert.isString(doc.updatedAt)
  })

  test('getArticle returns null for a missing document (404 -> null)', async ({ assert }) => {
    stubFetch(() => jsonResponse({ message: 'Document not found' }, 404))

    const article = await Meili.getArticle(999999)

    assert.isNull(article)
  })

  test('request propagates non-404 errors', async ({ assert }) => {
    stubFetch(() => jsonResponse({ message: 'bad request' }, 400))

    await assert.rejects(() => Meili['request']('/indexes/articles/search', { method: 'POST' }))
  })

  test('request returns null on 204 and parses JSON on 200', async ({ assert }) => {
    stubFetch((_url: string, init: any) =>
      init?.method === 'DELETE' ? jsonResponse(null, 204) : jsonResponse({ hits: [], estimatedTotalHits: 0 })
    )
    const parsed = await Meili['request']('/indexes/articles/search', { method: 'POST' })
    assert.deepEqual(parsed, { hits: [], estimatedTotalHits: 0 })

    const empty = await Meili['request']('/x', { method: 'DELETE' })
    assert.isNull(empty)
  })

  test('getArticles coerces string pagination params to numbers', async ({ assert }) => {
    stubFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }))

    await Meili.getArticles({ page: '2' as any, limit: '15' as any })

    assert.equal(fetchCalls.length, 1)
    const body = JSON.parse(fetchCalls[0].init.body)
    assert.equal(body.limit, 15)
    assert.equal(body.offset, 15) // (2 - 1) * 15
    assert.equal(body.sort[0], 'publishedAt:desc')
  })

  test('getArticles builds filter clauses from params', async ({ assert }) => {
    stubFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }))

    await Meili.getArticles({ source: 'Google News', analyzed: true, sentiment: 'bullish' })

    const body = JSON.parse(fetchCalls[0].init.body)
    assert.isArray(body.filter)
    assert.include(body.filter, 'sourceName = "Google News"')
    assert.include(body.filter, 'isAnalyzed = true')
    assert.include(body.filter, 'sentiment = "bullish"')
  })

  test('getArticles computes lastPage from total', async ({ assert }) => {
    stubFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 47 }))

    const result = await Meili.getArticles({ page: 2, limit: 20 })

    assert.equal(result.total, 47)
    assert.equal(result.lastPage, 3)
    assert.equal(result.page, 2)
    assert.equal(result.perPage, 20)
  })

  test('searchLogs coerces from/size and applies filters', async ({ assert }) => {
    stubFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }))

    await Meili.searchLogs({ level: 'error', context: 'trading', from: '10' as any, size: '25' as any })

    const body = JSON.parse(fetchCalls[0].init.body)
    assert.equal(body.limit, 25)
    assert.equal(body.offset, 10)
    assert.deepEqual(body.filter, ['level = "error"', 'context = "trading"'])
    assert.equal(body.sort[0], 'timestamp:desc')
  })

  test('pushLog buffers and flushes when the buffer reaches 50 entries', async ({ assert }) => {
    stubFetch(() => jsonResponse(null, 204))
    for (let i = 0; i < 50; i++) {
      Meili.pushLog({ timestamp: new Date().toISOString(), level: 'info', levelNumber: 30, message: `log ${i}` })
    }

    await new Promise((r) => setTimeout(r, 10))
    assert.equal(fetchCalls.length, 1)
    assert.match(fetchCalls[0].url, /indexes\/logs\/documents$/)
    const docs = JSON.parse(fetchCalls[0].init.body)
    assert.equal(docs.length, 50)
    assert.equal(Meili['logBuffer'].length, 0)
  })

  test('saveSnapshots batches documents in chunks of 1000', async ({ assert }) => {
    const writes: any[] = []
    stubFetch((_url: string, init: any) => {
      writes.push(JSON.parse(init.body))
      return jsonResponse(null, 204)
    })

    const snapshots = Array.from({ length: 2500 }, (_, i) => ({
      tickerId: 1,
      tickerSymbol: 'AAPL',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
      volume: 1000, changePercent: 0, date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    }))

    await Meili.saveSnapshots(snapshots)

    assert.equal(writes.length, 3)
    assert.equal(writes[0].length, 1000)
    assert.equal(writes[1].length, 1000)
    assert.equal(writes[2].length, 500)
    assert.equal(writes[0][0].id, '1_2026-01-01')
  })

  test('saveSnapshots does nothing for an empty array', async ({ assert }) => {
    stubFetch(() => jsonResponse(null, 204))
    await Meili.saveSnapshots([])
    assert.equal(fetchCalls.length, 0)
  })

  test('getSnapshotsForTicker filters and sorts by date asc', async ({ assert }) => {
    stubFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 0 }))

    await Meili.getSnapshotsForTicker(5)

    const body = JSON.parse(fetchCalls[0].init.body)
    assert.equal(body.filter, 'tickerId = 5')
    assert.deepEqual(body.sort, ['date:asc'])
    assert.equal(body.limit, 10000)
  })

  test('countArticles sends limit 0 and returns estimatedTotalHits', async ({ assert }) => {
    stubFetch(() => jsonResponse({ hits: [], estimatedTotalHits: 123 }))

    const total = await Meili.countArticles('isAnalyzed = false')

    const body = JSON.parse(fetchCalls[0].init.body)
    assert.equal(body.limit, 0)
    assert.equal(body.filter, 'isAnalyzed = false')
    assert.equal(total, 123)
  })

  test('getStats aggregates index document counts', async ({ assert }) => {
    stubFetch(() =>
      jsonResponse({
        indexes: {
          articles: { numberOfDocuments: 10, isIndexing: false },
          analyses: { numberOfDocuments: 4, isIndexing: true },
        },
      })
    )

    const stats = await Meili.getStats()

    assert.equal(stats.totalDocs, 14)
    assert.equal(stats.indexes.length, 2)
    assert.deepEqual(stats.indexes[0], { name: 'articles', docs: 10, isIndexing: false })
  })

  test('getStats falls back to empty on failure', async ({ assert }) => {
    stubFetch(() => {
      throw new Error('meili down')
    })

    const stats = await Meili.getStats()

    assert.deepEqual(stats, { indexes: [], totalDocs: 0 })
  })
})
