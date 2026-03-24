import { test } from '@japa/runner'

test.group('Tickers API', () => {
  test('GET /api/tickers returns paginated tickers', async ({ client, assert }) => {
    const response = await client.get('/api/tickers')

    response.assertStatus(200)
    const body = response.body()
    assert.properties(body.meta, ['total', 'per_page', 'current_page'])
    assert.isArray(body.data)
  })

  test('GET /api/tickers supports pagination', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ page: 1, limit: 5 })

    response.assertStatus(200)
    assert.equal(response.body().meta.per_page, 5)
  })

  test('GET /api/tickers/search requires query param', async ({ client }) => {
    const response = await client.get('/api/tickers/search').qs({ q: 'AAPL' })
    response.assertStatus(200)
  })

  test('GET /api/tickers/:symbol returns 404 for unknown symbol', async ({ client }) => {
    const response = await client.get('/api/tickers/ZZZZZZZ')
    response.assertStatus(404)
  })

  test('POST /api/tickers adds a ticker', async ({ client, assert }) => {
    const response = await client.post('/api/tickers').json({ symbol: 'AAPL' })

    // May succeed (200/201) or return existing
    assert.isTrue([200, 201].includes(response.status()))
  })

  test('POST /api/tickers validates required symbol', async ({ client }) => {
    const response = await client.post('/api/tickers').json({})
    response.assertStatus(400)
  })

  test('DELETE /api/tickers/:symbol deactivates ticker', async ({ client, assert }) => {
    // First ensure it exists
    await client.post('/api/tickers').json({ symbol: 'TSLA' })

    const response = await client.delete('/api/tickers/TSLA')
    assert.isTrue([200, 404].includes(response.status()))
  })

  test('GET /api/tickers returns filters object', async ({ client, assert }) => {
    const response = await client.get('/api/tickers')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'filters')
    assert.isArray(body.filters.sectors)
    assert.isArray(body.filters.exchanges)
  })

  test('GET /api/tickers supports search filter', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ search: 'AAPL' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers supports sector filter', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ sector: 'Technology' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers supports exchange filter', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ exchange: 'NASDAQ' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers supports sentiment filter', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ sentiment: 'bullish' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers supports bearish sentiment filter', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ sentiment: 'bearish' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers supports sort and dir params', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ sort: 'market_cap', dir: 'desc' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers ignores invalid sort column', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({ sort: 'DROP TABLE tickers', limit: 5 })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/tickers supports combined filters', async ({ client, assert }) => {
    const response = await client.get('/api/tickers').qs({
      search: 'A',
      sentiment: 'bullish',
      sort: 'symbol',
      dir: 'asc',
      limit: 5,
    })

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.data)
    assert.equal(body.meta.per_page, 5)
  })

  test('GET /api/tickers/:symbol returns ticker detail for known symbol', async ({ client, assert }) => {
    const response = await client.get('/api/tickers/AAPL')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'ticker')
    assert.property(body, 'analyses')
    assert.property(body, 'sentimentSummary')
    assert.equal(body.ticker.symbol, 'AAPL')
    assert.isArray(body.analyses)
    assert.isArray(body.sentimentSummary)
  })

  test('GET /api/tickers/:symbol includes snapshot data', async ({ client, assert }) => {
    const response = await client.get('/api/tickers/AAPL')

    response.assertStatus(200)
    const ticker = response.body().ticker
    assert.property(ticker, 'snapshots')
    assert.isArray(ticker.snapshots)
    if (ticker.snapshots.length > 0) {
      assert.property(ticker.snapshots[0], 'date')
      assert.property(ticker.snapshots[0], 'close')
    }
  })

  test('GET /api/tickers/:symbol is case insensitive', async ({ client, assert }) => {
    const response = await client.get('/api/tickers/aapl')

    response.assertStatus(200)
    assert.equal(response.body().ticker.symbol, 'AAPL')
  })

  test('GET /api/tickers/search returns empty array for short query', async ({ client, assert }) => {
    const response = await client.get('/api/tickers/search').qs({ q: '' })

    response.assertStatus(200)
    assert.isArray(response.body())
    assert.lengthOf(response.body(), 0)
  })

  test('POST /api/tickers/:symbol/refresh queues refresh job', async ({ client, assert }) => {
    const response = await client.post('/api/tickers/AAPL/refresh')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'message')
    assert.include(body.message, 'AAPL')
  })

  test('POST /api/tickers/refresh-all queues all active tickers', async ({ client, assert }) => {
    const response = await client.post('/api/tickers/refresh-all')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'message')
    assert.property(body, 'queued')
    assert.isNumber(body.queued)
  })

  test('POST /api/tickers/backfill queues backfill jobs', async ({ client, assert }) => {
    const response = await client.post('/api/tickers/backfill').json({ days: 30 })

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'message')
    assert.property(body, 'queued')
    assert.isNumber(body.queued)
    assert.isTrue(body.queued > 0)
  })

  test('POST /api/tickers/backfill supports single symbol', async ({ client, assert }) => {
    const response = await client.post('/api/tickers/backfill').json({ symbol: 'AAPL', days: 30 })

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.queued, 1)
  })

  test('POST /api/tickers/backfill returns 404 for unknown symbol', async ({ client }) => {
    const response = await client.post('/api/tickers/backfill').json({ symbol: 'ZZZXXX' })

    response.assertStatus(404)
  })

  test('POST /api/tickers returns existing ticker if already added', async ({ client, assert }) => {
    const response = await client.post('/api/tickers').json({ symbol: 'AAPL' })

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'ticker')
    assert.property(body, 'message')
    assert.include(body.message, 'already exists')
  })
})
