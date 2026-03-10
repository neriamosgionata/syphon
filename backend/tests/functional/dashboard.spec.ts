import { test } from '@japa/runner'

test.group('Dashboard API', () => {
  test('GET /api/dashboard returns dashboard data', async ({ client, assert }) => {
    const response = await client.get('/api/dashboard')

    response.assertStatus(200)
    assert.properties(response.body(), [
      'stats',
      'queues',
      'recentAnalyses',
      'sentimentDistribution',
      'topTickers',
    ])
  })

  test('GET /api/dashboard returns correct types', async ({ client, assert }) => {
    const response = await client.get('/api/dashboard')

    response.assertStatus(200)
    const body = response.body()
    assert.isObject(body.stats)
    assert.isNumber(body.stats.totalArticles)
    assert.isNumber(body.stats.totalTickers)
    assert.isNumber(body.stats.totalAnalyses)
    assert.isArray(body.recentAnalyses)
    assert.isArray(body.topTickers)
  })

  test('GET /api/jobs/active returns jobs array', async ({ client, assert }) => {
    const response = await client.get('/api/jobs/active')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'jobs')
    assert.isArray(body.jobs)
  })

  test('GET /api/jobs/active returns correct job structure', async ({ client, assert }) => {
    const response = await client.get('/api/jobs/active')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.jobs)

    // If there are active jobs, validate their structure
    if (body.jobs.length > 0) {
      const job = body.jobs[0]
      assert.property(job, 'id')
      assert.property(job, 'queue')
      assert.property(job, 'state')
      assert.property(job, 'data')
      assert.property(job, 'progress')
      assert.property(job, 'stage')
      assert.property(job, 'timestamp')
      assert.isNumber(job.progress)
      assert.include(['active', 'waiting', 'delayed'], job.state)
    }
  })

  test('GET /api/jobs/failed returns jobs array', async ({ client, assert }) => {
    const response = await client.get('/api/jobs/failed')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'jobs')
    assert.isArray(body.jobs)
  })

  test('GET /api/jobs/failed returns correct job structure', async ({ client, assert }) => {
    const response = await client.get('/api/jobs/failed')

    response.assertStatus(200)
    const body = response.body()

    if (body.jobs.length > 0) {
      const job = body.jobs[0]
      assert.property(job, 'id')
      assert.property(job, 'queue')
      assert.property(job, 'data')
      assert.property(job, 'failedReason')
      assert.property(job, 'stacktrace')
      assert.property(job, 'attemptsMade')
      assert.property(job, 'timestamp')
      assert.isString(job.failedReason)
      assert.isArray(job.stacktrace)
      assert.isNumber(job.attemptsMade)
    }
  })

  test('GET /api/jobs/failed supports limit param', async ({ client, assert }) => {
    const response = await client.get('/api/jobs/failed').qs({ limit: 5 })

    response.assertStatus(200)
    assert.isTrue(response.body().jobs.length <= 5)
  })

  test('POST /api/jobs/:queue/:id/retry returns 404 for nonexistent', async ({ client }) => {
    const response = await client.post('/api/jobs/scrape-news/nonexistent999/retry')
    response.assertStatus(404)
  })

  test('DELETE /api/jobs/:queue/:id returns 404 for nonexistent', async ({ client }) => {
    const response = await client.delete('/api/jobs/scrape-news/nonexistent999')
    response.assertStatus(404)
  })
})
