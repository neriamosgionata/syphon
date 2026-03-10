import { test } from '@japa/runner'

test.group('Articles API', () => {
  test('GET /api/articles returns paginated articles', async ({ client, assert }) => {
    const response = await client.get('/api/articles')

    response.assertStatus(200)
    const body = response.body()
    assert.properties(body.meta, ['total', 'per_page', 'current_page'])
    assert.isArray(body.data)
  })

  test('GET /api/articles supports pagination params', async ({ client, assert }) => {
    const response = await client.get('/api/articles').qs({ page: 1, limit: 5 })

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.meta.per_page, 5)
    assert.equal(body.meta.current_page, 1)
  })

  test('GET /api/articles supports source filter', async ({ client }) => {
    const response = await client.get('/api/articles').qs({ source: 'Google News' })
    response.assertStatus(200)
  })

  test('GET /api/articles supports analyzed filter', async ({ client }) => {
    const response = await client.get('/api/articles').qs({ analyzed: 'true' })
    response.assertStatus(200)
  })

  test('GET /api/articles supports sentiment filter', async ({ client, assert }) => {
    const response = await client.get('/api/articles').qs({ sentiment: 'bullish' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/articles supports combined filters', async ({ client, assert }) => {
    const response = await client.get('/api/articles').qs({
      analyzed: 'true',
      sentiment: 'very_bullish',
      page: 1,
      limit: 5,
    })

    response.assertStatus(200)
    assert.isArray(response.body().data)
    assert.equal(response.body().meta.per_page, 5)
  })

  test('GET /api/articles/sources returns source list', async ({ client, assert }) => {
    const response = await client.get('/api/articles/sources')

    response.assertStatus(200)
    assert.isArray(response.body())
  })

  test('GET /api/articles/search requires query', async ({ client }) => {
    const response = await client.get('/api/articles/search').qs({ q: 'stock' })
    // Should succeed or return empty results
    response.assertStatus(200)
  })

  test('GET /api/articles/:id returns 404 for nonexistent article', async ({ client }) => {
    const response = await client.get('/api/articles/999999')
    response.assertStatus(404)
  })

  test('POST /api/articles/scrape queues scrape job', async ({ client, assert }) => {
    const response = await client.post('/api/articles/scrape').json({})

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'message')
  })

  test('POST /api/articles/analyze queues analysis jobs', async ({ client, assert }) => {
    const response = await client.post('/api/articles/analyze').json({})

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'message')
  })
})
