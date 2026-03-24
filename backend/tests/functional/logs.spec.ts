import { test } from '@japa/runner'

test.group('Logs API', () => {
  test('GET /api/logs returns paginated logs', async ({ client, assert }) => {
    const response = await client.get('/api/logs')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'total')
    assert.property(body, 'logs')
    assert.property(body, 'page')
    assert.property(body, 'perPage')
    assert.isArray(body.logs)
    assert.isNumber(body.total)
    assert.equal(body.page, 1)
    assert.equal(body.perPage, 50)
  })

  test('GET /api/logs supports pagination params', async ({ client, assert }) => {
    const response = await client.get('/api/logs?page=2&per_page=10')

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.page, 2)
    assert.equal(body.perPage, 10)
  })

  test('GET /api/logs supports level filter', async ({ client, assert }) => {
    const response = await client.get('/api/logs?level=error')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.logs)
  })

  test('GET /api/logs supports query filter', async ({ client, assert }) => {
    const response = await client.get('/api/logs?q=test')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.logs)
  })

  test('GET /api/logs supports context filter', async ({ client, assert }) => {
    const response = await client.get('/api/logs?context=scraper')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.logs)
  })

  test('GET /api/logs supports date range filters', async ({ client, assert }) => {
    const response = await client.get('/api/logs?date_from=2025-01-01&date_to=2026-12-31')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.logs)
  })

  test('GET /api/logs/stats returns log statistics', async ({ client, assert }) => {
    const response = await client.get('/api/logs/stats')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'totalLogs')
    assert.property(body, 'byLevel')
    assert.property(body, 'byContext')
    assert.property(body, 'overTime')
    assert.property(body, 'errorsOverTime')
    assert.isNumber(body.totalLogs)
    assert.isArray(body.byLevel)
    assert.isArray(body.byContext)
    assert.isArray(body.overTime)
    assert.isArray(body.errorsOverTime)
  })

  test('GET /api/logs/stats byLevel has correct structure', async ({ client, assert }) => {
    const response = await client.get('/api/logs/stats')

    response.assertStatus(200)
    const body = response.body()
    if (body.byLevel.length > 0) {
      assert.property(body.byLevel[0], 'level')
      assert.property(body.byLevel[0], 'count')
    }
  })

  test('GET /api/logs/stats byContext has correct structure', async ({ client, assert }) => {
    const response = await client.get('/api/logs/stats')

    response.assertStatus(200)
    const body = response.body()
    if (body.byContext.length > 0) {
      assert.property(body.byContext[0], 'context')
      assert.property(body.byContext[0], 'count')
    }
  })
})
