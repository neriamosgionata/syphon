import { test } from '@japa/runner'

// FastTradingController drives the in-memory FastTradeEngine singleton. In
// the functional suite the engine is real but inert: no API keys are set, so
// start() refuses to run and placing orders short-circuits with a 503.

test.group('Fast Trading API', () => {
  test('GET /api/fast/status returns engine status', async ({ client, assert }) => {
    const response = await client.get('/api/fast/status')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'running')
    assert.property(body, 'activeOrders')
    assert.property(body, 'totalOrders')
    assert.property(body, 'subscribedSymbols')
    assert.isArray(body.subscribedSymbols)
    assert.isObject(body.prices)
    assert.isNumber(body.activeOrders)
  })

  test('POST /api/fast/start without API keys leaves engine stopped', async ({ client, assert }) => {
    const response = await client.post('/api/fast/start').json({ symbols: 'BTC,ETH' })

    response.assertStatus(200)
    const body = response.body()
    assert.isFalse(body.running)
    assert.property(body, 'symbols')
    assert.property(body, 'message')
  })

  test('POST /api/fast/stop returns ok even when not running', async ({ client, assert }) => {
    const response = await client.post('/api/fast/stop')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'running')
  })

  test('GET /api/fast/orders returns empty order list', async ({ client, assert }) => {
    const response = await client.get('/api/fast/orders')

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.orders)
    assert.equal(body.count, body.orders.length)
  })

  test('GET /api/fast/orders supports symbol and active filters', async ({ client, assert }) => {
    const response = await client.get('/api/fast/orders').qs({ symbol: 'BTC', active: 'true' })

    response.assertStatus(200)
    assert.isArray(response.body().orders)
  })

  test('GET /api/fast/orders/:id returns 404 for unknown order', async ({ client }) => {
    const response = await client.get('/api/fast/orders/does-not-exist')
    response.assertStatus(404)
  })

  test('GET /api/fast/prices/:symbol returns null price when unsubscribed', async ({ client, assert }) => {
    const response = await client.get('/api/fast/prices/ZZZZ')

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.symbol, 'ZZZZ')
    assert.isNull(body.price)
    assert.isTrue(body.stale)
  })

  test('GET /api/fast/prices/:symbol is case insensitive', async ({ client, assert }) => {
    const response = await client.get('/api/fast/prices/zzzz')

    response.assertStatus(200)
    assert.equal(response.body().symbol, 'ZZZZ')
  })

  test('POST /api/fast/orders validates symbol', async ({ client }) => {
    const response = await client.post('/api/fast/orders').json({ side: 'BUY', quantity: 1 })
    response.assertStatus(400)
  })

  test('POST /api/fast/orders validates side enum', async ({ client }) => {
    const response = await client.post('/api/fast/orders').json({ symbol: 'BTC', side: 'HOLD', quantity: 1 })
    response.assertStatus(400)
  })

  test('POST /api/fast/orders validates quantity > 0', async ({ client }) => {
    const response = await client.post('/api/fast/orders').json({ symbol: 'BTC', side: 'BUY', quantity: 0 })
    response.assertStatus(400)
  })

  test('POST /api/fast/orders validates order_type', async ({ client }) => {
    const response = await client.post('/api/fast/orders').json({
      symbol: 'BTC', side: 'BUY', quantity: 1, order_type: 'OCO',
    })
    response.assertStatus(400)
  })

  test('POST /api/fast/orders returns 503 when engine is not running', async ({ assert }) => {
    // api-client throws on >=500; talk to the live server directly.
    const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/fast/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC', side: 'BUY', quantity: 0.5 }),
    })

    assert.equal(res.status, 503)
    const body = await res.json()
    assert.match(body.error, /not running/i)
  })

  test('POST /api/fast/orders/:id/cancel returns 400 for unknown order', async ({ client }) => {
    const response = await client.post('/api/fast/orders/does-not-exist/cancel')
    response.assertStatus(400)
  })

  test('POST /api/fast/subscribe adds symbols to the WS cache', async ({ client, assert }) => {
    const response = await client.post('/api/fast/subscribe').json({ symbols: 'btcusdt, ETH' })

    response.assertStatus(200)
    const body = response.body()
    assert.isArray(body.subscribed)
    assert.include(body.subscribed, 'BTC')
    assert.include(body.subscribed, 'ETH')
  })
})
