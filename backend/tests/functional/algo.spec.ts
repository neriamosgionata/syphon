import { test } from '@japa/runner'

// AlgoController surfaces the algo trading config + decisions/positions/stats.
// All endpoints work on the dev SQLite DB (config row 1 exists via
// getConfig().ensureDefault()). Tests that mutate the config restore the
// original values afterwards so the suite stays idempotent.

let originalConfig: Record<string, any> | null = null

async function loadConfigRow() {
  const { default: AlgoConfig } = await import('App/Models/AlgoConfig')
  const row = await AlgoConfig.find(1)
  return row ? row.toJSON() : null
}

test.group('Algo API', (group) => {
  group.setup(async () => {
    originalConfig = await loadConfigRow()
  })

  group.teardown(async () => {
    if (!originalConfig) return
    const base = `http://127.0.0.1:${process.env.PORT}`
    // Restore API-managed fields through the API so snake_case -> camelCase
    // mapping and the boolean conversion apply (setting row['snake_key']
    // directly would be a no-op on the model).
    await fetch(`${base}/api/algo/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(originalConfig),
    })
    // enabled/disabled_reason aren't fully restorable via the API (disabling
    // always writes 'manually disabled'), so patch them on the model.
    const { default: AlgoConfig } = await import('App/Models/AlgoConfig')
    const row = await AlgoConfig.find(1)
    if (row) {
      row.enabled = !!originalConfig.enabled
      row.disabledReason = originalConfig.disabled_reason
      await row.save()
    }
  })

  test('GET /api/algo/config returns config with defaults', async ({ client, assert }) => {
    const response = await client.get('/api/algo/config')

    response.assertStatus(200)
    const body = response.body()
    assert.include([0, 1], body.enabled) // SQLite stores booleans as integers
    assert.include([0, 1], body.dry_run)
    assert.isString(body.broker)
    assert.include(['ibkr', 'kraken', 'binance'], body.broker)
    assert.isNumber(body.entry_score_threshold)
    assert.isNumber(body.max_positions)
    assert.isArray(body.allowed_regimes)
  })

  test('PUT /api/algo/config updates numeric fields', async ({ client, assert }) => {
    const before = (await client.get('/api/algo/config')).body()
    const response = await client.put('/api/algo/config').json({
      entryScoreThreshold: 55,
      maxPositions: 7,
      broker: 'binance',
      dryRun: false,
    })

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.entry_score_threshold, 55)
    assert.equal(body.max_positions, 7)
    assert.equal(body.broker, 'binance')
    assert.equal(body.dry_run, 0)

    // Restore whatever the suite started with
    if (before) {
      await client.put('/api/algo/config').json({
        entry_score_threshold: before.entry_score_threshold,
        max_positions: before.max_positions,
        broker: before.broker,
        dry_run: before.dry_run,
      })
    }
  })

  test('PUT /api/algo/config accepts snake_case keys', async ({ client, assert }) => {
    const response = await client.put('/api/algo/config').json({ min_conviction: 0.5 })

    response.assertStatus(200)
    assert.equal(response.body().min_conviction, 0.5)
  })

  test('PUT /api/algo/config rejects non-numeric values', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ entryScoreThreshold: 'abc' })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config rejects out-of-range values', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ entryScoreThreshold: 1000 })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config rejects minConviction outside 0..1', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ minConviction: 1.5 })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config rejects invalid broker', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ broker: 'robinhood' })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config rejects invalid orderType', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ orderType: 'STP' })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config rejects non-array allowedRegimes', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ allowedRegimes: 'trending_up' })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config rejects invalid regimes in allowedRegimes', async ({ client }) => {
    const response = await client.put('/api/algo/config').json({ allowedRegimes: ['mooning'] })
    response.assertStatus(400)
  })

  test('PUT /api/algo/config accepts excludedSymbols array', async ({ client, assert }) => {
    const response = await client.put('/api/algo/config').json({ excludedSymbols: ['XOM', 'GM'] })

    response.assertStatus(200)
    assert.deepEqual(response.body().excluded_symbols, ['XOM', 'GM'])
  })

  test('POST /api/algo/enable enables the algorithm', async ({ client, assert }) => {
    const response = await client.post('/api/algo/enable')

    response.assertStatus(200)
    assert.isTrue(response.body().enabled)
    const config = await loadConfigRow()
    assert.equal(config?.enabled, 1)
  })

  test('POST /api/algo/disable disables the algorithm with reason', async ({ client, assert }) => {
    const response = await client.post('/api/algo/disable')

    response.assertStatus(200)
    assert.isFalse(response.body().enabled)
    const config = await loadConfigRow()
    assert.equal(config?.enabled, 0)
    assert.equal(config?.disabled_reason, 'manually disabled')
  })

  test('POST /api/algo/run queues an algo trading job', async ({ client, assert }) => {
    const response = await client.post('/api/algo/run')

    response.assertStatus(200)
    assert.isTrue(response.body().queued)
    assert.property(response.body(), 'message')
  })

  test('GET /api/algo/decisions returns paginated decisions', async ({ client, assert }) => {
    const response = await client.get('/api/algo/decisions')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.data)
    assert.equal(body.meta.current_page, 1)
    assert.isNumber(body.meta.total)
  })

  test('GET /api/algo/decisions supports filters', async ({ client, assert }) => {
    const response = await client.get('/api/algo/decisions').qs({ symbol: 'AAPL', run_id: 'x' })

    response.assertStatus(200)
    assert.isArray(response.body().data)
  })

  test('GET /api/algo/positions returns open positions', async ({ client, assert }) => {
    const response = await client.get('/api/algo/positions')

    response.assertStatus(200)
    assert.isArray(response.body())
  })

  test('GET /api/algo/positions supports status filter', async ({ client, assert }) => {
    const response = await client.get('/api/algo/positions').qs({ status: 'all' })
    response.assertStatus(200)
    assert.isArray(response.body())
  })

  test('POST /api/algo/positions/:id/close returns 404 for unknown position', async ({ client }) => {
    const response = await client.post('/api/algo/positions/999999/close')
    response.assertStatus(404)
  })

  test('GET /api/algo/stats returns statistics', async ({ client, assert }) => {
    const response = await client.get('/api/algo/stats')

    response.assertStatus(200)
    const body = response.body()
    assert.include([0, 1], body.algoEnabled)
    assert.include([0, 1], body.dryRun)
    assert.isNumber(body.openPositions)
    assert.isNumber(body.totalRuns)
  })
})
