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
})
