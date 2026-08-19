import { test } from '@japa/runner'
import NotificationService from '../../app/services/NotificationService.js'

test.group('NotificationService', () => {

  test('subscribe returns an unsubscribe function', ({ assert }) => {
    const unsubscribe = NotificationService.subscribe(() => {})
    assert.isFunction(unsubscribe)
    unsubscribe()
  })

  test('emit delivers notification to subscribers', ({ assert }) => {
    const received: any[] = []
    const unsubscribe = NotificationService.subscribe((n: any) => received.push(n))

    const notification = {
      type: 'ticker_match' as const,
      articleId: 1,
      articleTitle: 'Test Article',
      articleUrl: 'https://example.com',
      sourceName: 'Test Source',
      ticker: { symbol: 'AAPL', name: 'Apple Inc', currentPrice: 150 },
      sentiment: 'bullish',
      sentimentScore: 0.5,
      relevanceScore: 0.8,
      confidence: 0.75,
      keywords: ['growth'],
      timestamp: new Date().toISOString(),
    }

    NotificationService.emit(notification)
    assert.lengthOf(received, 1)
    assert.deepEqual(received[0], notification)

    unsubscribe()
  })

  test('unsubscribe stops receiving notifications', ({ assert }) => {
    const received: any[] = []
    const unsubscribe = NotificationService.subscribe((n: any) => received.push(n))

    NotificationService.emit({
      type: 'scrape_complete',
      totalSaved: 5,
      sourcesProcessed: 2,
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 1)

    unsubscribe()

    NotificationService.emit({
      type: 'scrape_complete',
      totalSaved: 10,
      sourcesProcessed: 3,
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 1)
  })

  test('multiple subscribers all receive notifications', ({ assert }) => {
    const received1: any[] = []
    const received2: any[] = []

    const unsub1 = NotificationService.subscribe((n: any) => received1.push(n))
    const unsub2 = NotificationService.subscribe((n: any) => received2.push(n))

    NotificationService.emit({
      type: 'order_update',
      tradeId: 1,
      symbol: 'AAPL',
      side: 'BUY',
      status: 'filled',
      quantity: 10,
      fillPrice: 150.5,
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received1, 1)
    assert.lengthOf(received2, 1)

    unsub1()
    unsub2()
  })

  test('handles all notification types', ({ assert }) => {
    const received: any[] = []
    const unsub = NotificationService.subscribe((n: any) => received.push(n))

    NotificationService.emit({
      type: 'ticker_match',
      articleId: 1,
      articleTitle: 'Test',
      articleUrl: null,
      sourceName: null,
      ticker: { symbol: 'AAPL', name: 'Apple', currentPrice: null },
      sentiment: 'neutral',
      sentimentScore: 0,
      relevanceScore: 0.5,
      confidence: 0.5,
      keywords: null,
      timestamp: new Date().toISOString(),
    })

    NotificationService.emit({
      type: 'scrape_complete',
      totalSaved: 0,
      sourcesProcessed: 1,
      timestamp: new Date().toISOString(),
    })

    NotificationService.emit({
      type: 'order_update',
      tradeId: 2,
      symbol: 'MSFT',
      side: 'SELL',
      status: 'cancelled',
      quantity: 5,
      fillPrice: null,
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 3)
    assert.equal(received[0].type, 'ticker_match')
    assert.equal(received[1].type, 'scrape_complete')
    assert.equal(received[2].type, 'order_update')

    unsub()
  })

  test('handles job_progress notification type', ({ assert }) => {
    const received: any[] = []
    const unsub = NotificationService.subscribe((n: any) => received.push(n))

    NotificationService.emit({
      type: 'job_progress',
      queue: 'scrape-news',
      jobId: '42',
      progress: 60,
      stage: 'Scraping Reuters',
      detail: 'Source 3 of 5',
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 1)
    assert.equal(received[0].type, 'job_progress')
    assert.equal(received[0].queue, 'scrape-news')
    assert.equal(received[0].jobId, '42')
    assert.equal(received[0].progress, 60)
    assert.equal(received[0].stage, 'Scraping Reuters')
    assert.equal(received[0].detail, 'Source 3 of 5')

    unsub()
  })

  test('handles job_finished notification type with completed status', ({ assert }) => {
    const received: any[] = []
    const unsub = NotificationService.subscribe((n: any) => received.push(n))

    NotificationService.emit({
      type: 'job_finished',
      queue: 'fetch-ticker',
      jobId: '99',
      status: 'completed',
      result: { symbol: 'AAPL', price: 175.5 },
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 1)
    assert.equal(received[0].type, 'job_finished')
    assert.equal(received[0].status, 'completed')
    assert.equal(received[0].result.symbol, 'AAPL')

    unsub()
  })

  test('handles job_finished notification type with failed status', ({ assert }) => {
    const received: any[] = []
    const unsub = NotificationService.subscribe((n: any) => received.push(n))

    NotificationService.emit({
      type: 'job_finished',
      queue: 'analyze-article',
      jobId: '101',
      status: 'failed',
      error: 'Article not found',
      timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 1)
    assert.equal(received[0].type, 'job_finished')
    assert.equal(received[0].status, 'failed')
    assert.equal(received[0].error, 'Article not found')

    unsub()
  })

  test('handles all five notification types in sequence', ({ assert }) => {
    const received: any[] = []
    const unsub = NotificationService.subscribe((n: any) => received.push(n))

    NotificationService.emit({
      type: 'ticker_match',
      articleId: 1, articleTitle: 'Test', articleUrl: null, sourceName: null,
      ticker: { symbol: 'AAPL', name: 'Apple', currentPrice: null },
      sentiment: 'neutral', sentimentScore: 0, relevanceScore: 0.5,
      confidence: 0.5, keywords: null, timestamp: new Date().toISOString(),
    })
    NotificationService.emit({
      type: 'scrape_complete', totalSaved: 0, sourcesProcessed: 1,
      timestamp: new Date().toISOString(),
    })
    NotificationService.emit({
      type: 'order_update', tradeId: 2, symbol: 'MSFT', side: 'SELL',
      status: 'cancelled', quantity: 5, fillPrice: null,
      timestamp: new Date().toISOString(),
    })
    NotificationService.emit({
      type: 'job_progress', queue: 'scrape-news', jobId: '1',
      progress: 50, stage: 'Working', timestamp: new Date().toISOString(),
    })
    NotificationService.emit({
      type: 'job_finished', queue: 'scrape-news', jobId: '1',
      status: 'completed', timestamp: new Date().toISOString(),
    })

    assert.lengthOf(received, 5)
    assert.equal(received[0].type, 'ticker_match')
    assert.equal(received[1].type, 'scrape_complete')
    assert.equal(received[2].type, 'order_update')
    assert.equal(received[3].type, 'job_progress')
    assert.equal(received[4].type, 'job_finished')

    unsub()
  })
})
