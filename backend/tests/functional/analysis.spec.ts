import { test } from '@japa/runner'

test.group('Analysis API', () => {
  test('GET /api/analysis returns paginated analyses', async ({ client, assert }) => {
    const response = await client.get('/api/analysis')

    response.assertStatus(200)
    const body = response.body()
    assert.properties(body.meta, ['total', 'per_page', 'current_page'])
    assert.isArray(body.data)
  })

  test('GET /api/analysis supports ticker filter', async ({ client }) => {
    const response = await client.get('/api/analysis').qs({ ticker: 'AAPL' })
    response.assertStatus(200)
  })

  test('GET /api/analysis supports sentiment filter', async ({ client }) => {
    const response = await client.get('/api/analysis').qs({ sentiment: 'bullish' })
    response.assertStatus(200)
  })

  test('GET /api/analysis supports sorting', async ({ client }) => {
    const response = await client.get('/api/analysis').qs({ sort: 'score', order: 'desc' })
    response.assertStatus(200)
  })

  test('GET /api/analysis/:id returns 404 for nonexistent', async ({ client }) => {
    const response = await client.get('/api/analysis/999999')
    response.assertStatus(404)
  })

  test('GET /api/analysis/stats returns statistics', async ({ client, assert }) => {
    const response = await client.get('/api/analysis/stats')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'overall')
    assert.property(body, 'byTicker')
    assert.property(body, 'recent')
  })

  test('GET /api/analysis/timeline requires ticker param', async ({ client }) => {
    const response = await client.get('/api/analysis/timeline').qs({ ticker: 'AAPL' })
    response.assertStatus(200)
  })

  test('GET /api/analysis/timeline supports days param', async ({ client }) => {
    const response = await client.get('/api/analysis/timeline').qs({ ticker: 'AAPL', days: 7 })
    response.assertStatus(200)
  })
})
