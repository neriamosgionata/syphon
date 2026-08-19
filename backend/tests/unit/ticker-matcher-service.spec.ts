import { test } from '@japa/runner'
import { TickerMatcherService } from '../../app/services/TickerMatcherService.js'

// TickerMatcherService.matchAndAnalyze orchestrates: relevance scoring ->
// dedupe against existing analyses -> sentiment analysis -> save -> notify ->
// mark article analyzed. SentimentService is exercised for real; the Ticker
// model, Meili and Notification singletons are injected as fakes per test.

let Matcher: TickerMatcherService
let Meili: any
let Notifications: any
let activeTickers: any[]

const fakeMeili = {
  findAnalysis: async () => null,
  saveAnalysis: async () => ({ id: '0_0' }),
  updateArticle: async () => {},
  getAnalysesForTicker: async () => [],
}
const fakeNotifications = { emit: () => {} }

function makeTicker(id: number, symbol: string, name: string, currentPrice: number | null = null) {
  return { id, symbol, name, currentPrice }
}

const ARTICLE = {
  id: 1001,
  title: 'Apple beats earnings expectations with strong iPhone sales',
  summary: 'Record revenue quarter',
  content: 'Apple Inc reported better than expected results.',
  url: 'https://example.com/apple-earnings',
  sourceName: 'Test News',
  publishedAt: '2026-08-01T10:00:00.000Z',
}

test.group('TickerMatcherService', (group) => {
  const fakeTickerModel = {
    query: () => ({
      where: () => activeTickers,
    }),
  }

  group.setup(() => {
    Matcher = new TickerMatcherService({
      tickerModel: fakeTickerModel as any,
      meili: fakeMeili as any,
      notifications: fakeNotifications as any,
    })
    Meili = fakeMeili
    Notifications = fakeNotifications
  })

  group.each.setup(() => {
    activeTickers = []
    Meili['findAnalysis'] = async () => null
    Meili['saveAnalysis'] = async (a: any) => ({ id: `${a.articleId}_${a.tickerId}` })
    Meili['updateArticle'] = async () => {}
    Meili['getAnalysesForTicker'] = async () => []
    Notifications['emit'] = () => {}
  })


  group.each.setup(() => {
    activeTickers = []
    Meili['findAnalysis'] = async () => null
    Meili['saveAnalysis'] = async (a: any) => ({ id: `${a.articleId}_${a.tickerId}` })
    Meili['updateArticle'] = async () => {}
    Meili['getAnalysesForTicker'] = async () => []
    Notifications['emit'] = () => {}
  })

  test('creates analyses for tickers above the relevance threshold', async ({ assert }) => {
    activeTickers = [makeTicker(1, 'AAPL', 'Apple Inc', 200)]
    const saved: any[] = []
    Meili['saveAnalysis'] = async (a: any) => {
      saved.push(a)
      return { id: `${a.articleId}_${a.tickerId}` }
    }

    const results = await Matcher.matchAndAnalyze(ARTICLE)

    assert.equal(results.length, 1)
    assert.equal(results[0].tickerSymbol, 'AAPL')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].articleId, ARTICLE.id)
    assert.equal(saved[0].tickerId, 1)
    assert.isNumber(saved[0].sentimentScore)
    assert.isTrue(saved[0].relevanceScore >= 0.1)
  })

  test('skips tickers below the relevance threshold', async ({ assert }) => {
    // A ticker unrelated to the article content scores ~0 relevance.
    activeTickers = [makeTicker(2, 'MSFT', 'Microsoft Corp'), makeTicker(3, 'XOM', 'Exxon Mobil')]
    const saved: any[] = []
    Meili['saveAnalysis'] = async (a: any) => {
      saved.push(a)
      return { id: `${a.articleId}_${a.tickerId}` }
    }

    const results = await Matcher.matchAndAnalyze(ARTICLE)

    assert.equal(results.length, 0)
    assert.equal(saved.length, 0)
  })

  test('skips tickers that already have an analysis', async ({ assert }) => {
    activeTickers = [makeTicker(1, 'AAPL', 'Apple Inc')]
    Meili['findAnalysis'] = async (articleId: number, tickerId: number) =>
      articleId === ARTICLE.id && tickerId === 1 ? { id: `${articleId}_${tickerId}` } : null
    const saved: any[] = []
    Meili['saveAnalysis'] = async (a: any) => {
      saved.push(a)
      return { id: `${a.articleId}_${a.tickerId}` }
    }

    const results = await Matcher.matchAndAnalyze(ARTICLE)

    assert.equal(results.length, 0)
    assert.equal(saved.length, 0)
  })

  test('emits a notification for every matched ticker', async ({ assert }) => {
    activeTickers = [makeTicker(1, 'AAPL', 'Apple Inc', 210.5)]
    const emitted: any[] = []
    Notifications['emit'] = (n: any) => emitted.push(n)

    await Matcher.matchAndAnalyze(ARTICLE)

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].type, 'ticker_match')
    assert.equal(emitted[0].articleId, ARTICLE.id)
    assert.equal(emitted[0].ticker.symbol, 'AAPL')
    assert.equal(emitted[0].ticker.currentPrice, 210.5)
    assert.isString(emitted[0].timestamp)
  })

  test('marks the article as analyzed with top tickers and sentiment', async ({ assert }) => {
    activeTickers = [makeTicker(1, 'AAPL', 'Apple Inc'), makeTicker(2, 'MSFT', 'Microsoft Corp')]
    const updates: any[] = []
    Meili['updateArticle'] = async (id: number, patch: any) => updates.push({ id, patch })

    await Matcher.matchAndAnalyze(ARTICLE)

    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, ARTICLE.id)
    assert.isTrue(updates[0].patch.isAnalyzed)
    assert.isArray(updates[0].patch.tickers)
    assert.isTrue(updates[0].patch.tickers.length > 0)
    assert.isString(updates[0].patch.sentiment)
    assert.isNumber(updates[0].patch.sentimentScore)
  })

  test('returns empty results and still marks the article when nothing matches', async ({ assert }) => {
    activeTickers = [makeTicker(3, 'XOM', 'Exxon Mobil')]
    const updates: any[] = []
    Meili['updateArticle'] = async (id: number, patch: any) => updates.push({ id, patch })

    const results = await Matcher.matchAndAnalyze(ARTICLE)

    assert.equal(results.length, 0)
    assert.equal(updates.length, 1)
    assert.isTrue(updates[0].patch.isAnalyzed)
    assert.deepEqual(updates[0].patch.tickers, [])
    assert.isNull(updates[0].patch.sentiment)
  })

  test('handles articles without summary or content', async ({ assert }) => {
    activeTickers = [makeTicker(1, 'AAPL', 'Apple Inc')]
    const results = await Matcher.matchAndAnalyze({ ...ARTICLE, summary: null, content: null })
    assert.equal(results.length, 1)
    assert.equal(results[0].tickerSymbol, 'AAPL')
  })
})
