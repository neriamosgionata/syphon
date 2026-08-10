import { test } from '@japa/runner'

test.group('Metrics API', () => {
  test('GET /api/metrics returns all metric sections', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const body = response.body()
    assert.properties(body, ['system', 'database', 'redis', 'meilisearch', 'queues', 'services', 'timestamp'])
  })

  test('GET /api/metrics system section has process info', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const system = response.body().system
    assert.properties(system, ['uptime', 'memory', 'cpu', 'nodeVersion', 'platform', 'pid'])
    assert.isNumber(system.uptime)
    assert.isNumber(system.pid)
    assert.properties(system.memory, ['rss', 'heapUsed', 'heapTotal'])
  })

  test('GET /api/metrics database section lists SQLite tables (SQLite path)', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const db = response.body().database
    assert.isArray(db.tables)
    assert.isTrue(db.tables.length > 0, 'expected at least one table')
    for (const t of db.tables) {
      assert.property(t, 'name')
      assert.property(t, 'rows')
      assert.isNumber(t.rows)
    }
    assert.isNumber(db.totalRows)
    assert.isTrue(db.totalRows >= 0)
    assert.isNumber(db.totalSize)
    assert.isTrue(db.totalSize > 0, 'sqlite file size should be non-zero')
    const names = db.tables.map((t: any) => t.name)
    assert.include(names, 'tickers')
  })

  test('GET /api/metrics redis section has parsed info fields', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const redis = response.body().redis
    assert.isNumber(redis.usedMemory)
    assert.isString(redis.usedMemoryHuman)
    assert.isNumber(redis.totalKeys)
    assert.isNumber(redis.connectedClients)
    assert.isString(redis.version)
  })

  test('GET /api/metrics meilisearch section lists indexes with doc counts', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const meili = response.body().meilisearch
    assert.isArray(meili.indexes)
    assert.isNumber(meili.totalDocs)
    const names = meili.indexes.map((i: any) => i.name)
    assert.include(names, 'articles')
    assert.include(names, 'analyses')
  })

  test('GET /api/metrics queues section has totals', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const queues = response.body().queues
    assert.isObject(queues.queues)
    assert.properties(queues.totals, ['active', 'waiting', 'completed', 'failed'])
    assert.isNumber(queues.totals.active)
    assert.isNumber(queues.totals.waiting)
  })

  test('GET /api/metrics services health reports mysql/redis/meili', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const services = response.body().services
    // MySQL check runs SELECT 1 against the SQLite connection in this
    // environment, so it reports ok as long as the DB responds.
    assert.property(services.mysql, 'status')
    assert.property(services.mysql, 'latencyMs')
    assert.equal(services.redis.status, 'ok')
    assert.equal(services.meilisearch.status, 'ok')
  })

  test('GET /api/metrics timestamp is a valid ISO date', async ({ client, assert }) => {
    const response = await client.get('/api/metrics')

    response.assertStatus(200)
    const date = new Date(response.body().timestamp)
    assert.isFalse(isNaN(date.getTime()))
  })
})
