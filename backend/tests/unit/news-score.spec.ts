import { test } from '@japa/runner'
import { newsWindowScore, NewsEvent } from '../../app/services/NewsScore.js'
import { NewsSentimentService } from '../../app/services/NewsSentimentService.js'

// NewsScore: the shared pure aggregation behind the live loop and the
// backtester. NewsSentimentService: live wiring (analyses → events →
// score) with fake Meilisearch.

// The service scores against real Date.now(), so test events must be
// relative to the actual runtime clock — a fixed constant would land
// them in the future and the window filter would drop them.
const NOW = Date.now()
const HOUR = 3600_000

test.group('newsWindowScore', () => {
  test('returns null score with no events', ({ assert }) => {
    const result = newsWindowScore([], NOW, 24 * 3600)
    assert.isNull(result.score)
    assert.equal(result.events, 0)
    assert.equal(result.magnitude, 0)
  })

  test('single event returns its score', ({ assert }) => {
    const result = newsWindowScore([{ t: NOW - 1000, score: -0.5 }], NOW, 24 * 3600)
    assert.equal(result.score, -0.5)
    assert.equal(result.events, 1)
  })

  test('events outside the window are ignored', ({ assert }) => {
    const result = newsWindowScore(
      [
        { t: NOW - 2 * 24 * HOUR, score: -0.9 },
        { t: NOW - HOUR, score: 0.5 },
      ],
      NOW,
      24 * 3600
    )
    assert.equal(result.events, 1)
    assert.equal(result.score, 0.5)
  })

  test('future events are ignored', ({ assert }) => {
    const result = newsWindowScore([{ t: NOW + HOUR, score: 0.9 }], NOW, 24 * 3600)
    assert.equal(result.events, 0)
    assert.isNull(result.score)
  })

  test('recent events dominate the recency-weighted score', ({ assert }) => {
    const result = newsWindowScore(
      [
        { t: NOW - 23 * HOUR, score: -1.0 },
        { t: NOW - 60_000, score: 1.0 },
      ],
      NOW,
      24 * 3600
    )
    assert.isAbove(result.score!, 0.5) // the fresh +1.0 event outweighs the stale -1.0
  })

  test('events with the same id are counted once', ({ assert }) => {
    const result = newsWindowScore(
      [
        { id: 'ev1', t: NOW - HOUR, score: -0.8 },
        { id: 'ev1', t: NOW - 60_000, score: 0.9 },
        { id: 'ev2', t: NOW - 60_000, score: 0.1 },
      ],
      NOW,
      24 * 3600
    )
    assert.equal(result.events, 2)
  })

  test('weight scales the magnitude but not the direction', ({ assert }) => {
    const light = newsWindowScore([{ t: NOW - 1000, score: 0.5, weight: 1 }], NOW, 24 * 3600)
    const heavy = newsWindowScore([{ t: NOW - 1000, score: 0.5, weight: 3 }], NOW, 24 * 3600)
    assert.equal(light.score, heavy.score)
    assert.isAbove(heavy.magnitude, light.magnitude)
  })

  test('zero window returns null', ({ assert }) => {
    const result = newsWindowScore([{ t: NOW - 1000, score: 0.5 }], NOW, 0)
    assert.isNull(result.score)
  })
})

test.group('NewsSentimentService', () => {
  const nowIso = new Date(NOW).toISOString()

  function fakeMeili(analyses: any[]) {
    return {
      async getAnalysesForTicker(_tickerId: number, _since?: string) {
        return analyses
      },
    }
  }

  function analysis(overrides: any = {}) {
    return {
      articleId: 1,
      tickerId: 7,
      sentimentScore: 0.3,
      relevanceScore: 0.8,
      confidence: 0.6,
      eventKey: 'ev1',
      publishedAt: nowIso,
      createdAt: nowIso,
      ...overrides,
    }
  }

  test('collapses same-event analyses into one event with evidence bonus', ({ assert }) => {
    const service = new NewsSentimentService(fakeMeili([
      analysis({ articleId: 1, eventKey: 'ev1', sentimentScore: -0.5, publishedAt: new Date(NOW - 1000).toISOString() }),
      analysis({ articleId: 2, eventKey: 'ev1', sentimentScore: -0.5, publishedAt: new Date(NOW - 500).toISOString() }),
      analysis({ articleId: 3, eventKey: 'ev2', sentimentScore: 0.4, publishedAt: new Date(NOW - 1000).toISOString() }),
    ]) as any, {} as any)

    const events = service.analysesToEvents([
      analysis({ articleId: 1, eventKey: 'ev1', sentimentScore: -0.5, publishedAt: new Date(NOW - 1000).toISOString() }),
      analysis({ articleId: 2, eventKey: 'ev1', sentimentScore: -0.5, publishedAt: new Date(NOW - 500).toISOString() }),
      analysis({ articleId: 3, eventKey: 'ev2', sentimentScore: 0.4, publishedAt: new Date(NOW - 1000).toISOString() }),
    ])

    assert.equal(events.length, 2)
    const ev1 = events.find((e) => e.t === NOW - 1000)
    assert.isNotNull(ev1)
    assert.closeTo(ev1!.score, -0.5, 1e-9)
    assert.isAbove(ev1!.weight!, 1.0) // two sources agree → evidence bonus
  })

  test('analyses without eventKey each form their own event', ({ assert }) => {
    const service = new NewsSentimentService(fakeMeili([]) as any, {} as any)
    const events = service.analysesToEvents([
      analysis({ articleId: 1, eventKey: null, publishedAt: new Date(NOW - 1000).toISOString() }),
      analysis({ articleId: 2, eventKey: null, publishedAt: new Date(NOW - 1000).toISOString() }),
    ])
    assert.equal(events.length, 2)
  })

  test('getSymbolSentiment returns aggregated window score', async ({ assert }) => {
    const service = new NewsSentimentService(fakeMeili([
      analysis({ sentimentScore: -0.6, eventKey: 'ev1', publishedAt: new Date(NOW - 60_000).toISOString() }),
      analysis({ sentimentScore: 0.5, eventKey: 'ev2', publishedAt: new Date(NOW - 60_000).toISOString() }),
    ]) as any, {} as any)

    const result = await service.getSymbolSentiment(7, 24)
    assert.isNotNull(result)
    assert.equal(result!.events, 2)
    assert.isTrue(result!.score! >= -0.6 && result!.score! <= 0.5)
    assert.isAbove(result!.magnitude, 0)
  })

  test('getSymbolSentiment returns null with no analyses in window', async ({ assert }) => {
    const service = new NewsSentimentService(fakeMeili([]) as any, {} as any)
    const result = await service.getSymbolSentiment(7, 24)
    assert.isNull(result!.score)
    assert.equal(result!.events, 0)
  })

  test('meili failure fails open to null result', async ({ assert }) => {
    const broken = {
      async getAnalysesForTicker() { throw new Error('meili down') },
    }
    const service = new NewsSentimentService(broken as any, {} as any)
    const result = await service.getSymbolSentiment(7, 24)
    assert.isNull(result)
  })
})