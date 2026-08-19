import { test } from '@japa/runner'

test.group('Trading API', (group) => {
  let createdTradeId: number | null = null

  group.teardown(async () => {
    // This suite creates a real trade row and enqueues a SUBMIT_ORDER job.
    // Clean them up so repeated runs don't accumulate rows in the DB or jobs
    // in Redis.
    try {
      if (createdTradeId) {
        const { default: db } = await import('@adonisjs/lucid/services/db')
        await db.rawQuery('DELETE FROM trades WHERE id = ?', [createdTradeId])
      }
      const { default: QueueService } = await import('#jobs/QueueService')
      await QueueService.drainAll()
    } catch {
      /* noop */
    }
  })
  test('GET /api/trading/status returns connection status', async ({ client, assert }) => {
    const response = await client.get('/api/trading/status')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'connection')
    assert.property(body.connection, 'connected')
  })

  test('GET /api/trading/account returns 503 when not connected', async ({ client, assert }) => {
    const response = await client.get('/api/trading/account')
    assert.equal(response.status(), 503)
    assert.property(response.body(), 'error')
  })

  test('GET /api/trading/positions returns 503 when not connected', async ({ client, assert }) => {
    const response = await client.get('/api/trading/positions')
    assert.equal(response.status(), 503)
    assert.property(response.body(), 'error')
  })

  test('GET /api/trading/orders returns paginated trades', async ({ client, assert }) => {
    const response = await client.get('/api/trading/orders')

    response.assertStatus(200)
    const body = response.body()
    assert.properties(body.meta, ['total', 'per_page', 'current_page'])
    assert.isArray(body.data)
  })

  test('GET /api/trading/orders supports symbol filter', async ({ client }) => {
    const response = await client.get('/api/trading/orders').qs({ symbol: 'AAPL' })
    response.assertStatus(200)
  })

  test('GET /api/trading/orders supports status filter', async ({ client }) => {
    const response = await client.get('/api/trading/orders').qs({ status: 'filled' })
    response.assertStatus(200)
  })

  test('GET /api/trading/orders/:id returns 404 for nonexistent', async ({ client }) => {
    const response = await client.get('/api/trading/orders/999999')
    response.assertStatus(404)
  })

  test('GET /api/trading/stats returns trade statistics', async ({ client, assert }) => {
    const response = await client.get('/api/trading/stats')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'overview')
    assert.property(body, 'bySymbol')
    assert.property(body, 'byStatus')
    assert.property(body, 'recentFills')
  })

  test('POST /api/trading/orders validates required fields', async ({ client }) => {
    const response = await client.post('/api/trading/orders').json({})
    response.assertStatus(400)
  })

  test('POST /api/trading/orders validates side enum', async ({ client }) => {
    const response = await client.post('/api/trading/orders').json({
      symbol: 'AAPL',
      side: 'INVALID',
      quantity: 10,
      order_type: 'MKT',
    })
    response.assertStatus(400)
  })

  test('POST /api/trading/orders validates quantity > 0', async ({ client }) => {
    const response = await client.post('/api/trading/orders').json({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 0,
      order_type: 'MKT',
    })
    response.assertStatus(400)
  })

  test('POST /api/trading/orders validates order type', async ({ client }) => {
    const response = await client.post('/api/trading/orders').json({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      order_type: 'INVALID',
    })
    response.assertStatus(400)
  })

  test('POST /api/trading/orders validates limit_price for LMT orders', async ({ client }) => {
    const response = await client.post('/api/trading/orders').json({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      order_type: 'LMT',
    })
    response.assertStatus(400)
  })

  test('POST /api/trading/orders validates stop_price for STP orders', async ({ client }) => {
    const response = await client.post('/api/trading/orders').json({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      order_type: 'STP',
    })
    response.assertStatus(400)
  })

  test('POST /api/trading/orders creates MKT order', async ({ client, assert }) => {
    const response = await client.post('/api/trading/orders').json({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      order_type: 'MKT',
    })

    response.assertStatus(201)
    const body = response.body()
    assert.property(body, 'trade')
    assert.property(body, 'message')
    assert.equal(body.trade.symbol, 'AAPL')
    assert.equal(body.trade.side, 'BUY')
    assert.equal(body.trade.quantity, 10)
    assert.equal(body.trade.order_type, 'MKT')
    assert.equal(body.trade.status, 'pending')
    createdTradeId = body.trade.id
  })

  test('POST /api/trading/orders/:id/cancel returns 404 for nonexistent', async ({ client }) => {
    const response = await client.post('/api/trading/orders/999999/cancel')
    response.assertStatus(404)
  })

  test('POST /api/trading/disconnect returns disconnected status', async ({ client, assert }) => {
    const response = await client.post('/api/trading/disconnect')

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.connected, false)
  })
})
