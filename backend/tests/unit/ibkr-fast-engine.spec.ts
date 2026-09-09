import { test } from '@japa/runner'
import { IBKRFastEngine } from '../../app/services/IBKRFastEngine.js'
import Ticker from '../../app/models/Ticker.js'
import Trade from '../../app/models/Trade.js'

// IBKRFastEngine mirrors KrakenFastEngine: state machine + 100ms DB flush
// + trade linking. The ibkr facade is faked (order id allocation, raw
// placement, events); trades/tickers live in the throwaway unit DB.

function makeFakeIbkr() {
  const listeners = new Map<string, (...args: any[]) => void>()
  let orderSeq = 100
  const state: any = {
    placed: [] as any[],
    cancelled: [] as number[],
    orderId: () => orderSeq++,
    fire: (event: string, ...args: any[]) => listeners.get(event)?.(...args),
  }
  state.ibkr = {
    isConnected: true,
    connect: async () => true,
    allocateOrderId: async () => state.orderId(),
    placeRawOrder: async (orderId: number, contract: any, order: any) => {
      state.placed.push({ orderId, contract, order })
    },
    cancelRawOrder: async (orderId: number) => {
      state.cancelled.push(orderId)
    },
    buildOrder: (orderId: number, side: string, orderType: string, quantity: number, opts: any) => ({
      orderId, side, orderType, quantity,
      tif: opts?.timeInForce || 'DAY',
      orderRef: opts?.orderRef || null,
      lmtPrice: opts?.limitPrice || null,
    }),
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    getOpenOrders: async () => [],
  }
  return state
}

async function makeTicker(symbol = 'AAPL', overrides: Record<string, any> = {}) {
  return Ticker.create({
    symbol,
    name: symbol,
    secType: 'stock',
    exchange: 'SMART',
    currency: 'USD',
    isActive: true,
    ...overrides,
  })
}

function newEngine(ibkr: any) {
  const engine = new IBKRFastEngine(undefined as any, ibkr, Ticker)
  return engine
}

const flush = async (engine: any) => {
  await (engine as any).flushToDb()
}

test.group('IBKRFastEngine', () => {
  test('placeOrder allocates an order id, places raw and links the trade row', async ({ assert }) => {
    await makeTicker('AAPL')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    await engine.start([])

    const state = await engine.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: 10, orderType: 'MARKET' })

    assert.equal(state.status, 'submitted')
    assert.equal(state.externalOrderId, '100')
    assert.equal(fake.placed.length, 1)
    assert.equal(fake.placed[0].contract.symbol, 'AAPL')
    assert.equal(fake.placed[0].contract.secType, 'STK')
    assert.equal(fake.placed[0].order.orderRef, state.clientOrderId)
    assert.equal(fake.placed[0].order.orderId, 100)
    assert.equal(fake.placed[0].order.tif, 'DAY')

    await flush(engine)
    const trade = await Trade.findBy('client_order_id', state.clientOrderId)
    assert.isNotNull(trade)
    assert.equal(trade!.broker, 'ibkr')
    assert.equal(trade!.status, 'submitted')
    engine.stop()
  })

  test('missing ticker row produces an error state, no placement', async ({ assert }) => {
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    const state = await engine.placeOrder({ symbol: 'NOSUCH', side: 'BUY', quantity: 1 })

    assert.equal(state.status, 'error')
    assert.match(state.errorMessage!, /No ticker row/)
    assert.equal(fake.placed.length, 0)
    engine.stop()
  })

  test('orderStatus Filled updates state + persists the fill', async ({ assert }) => {
    await makeTicker('MSFT')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    await engine.start([])
    const state = await engine.placeOrder({ symbol: 'MSFT', side: 'BUY', quantity: 10 })

    fake.fire('orderStatus', 100, 'Filled', 10, 0, 101.5, 7777)
    assert.equal(state.status, 'filled')
    assert.equal(state.filledQuantity, 10)
    assert.equal(state.fillPrice, 101.5)
    assert.isNotNull(state.filledAt)

    await flush(engine)
    const trade = await Trade.findBy('client_order_id', state.clientOrderId)
    assert.equal(trade!.status, 'filled')
    assert.equal(trade!.filledQuantity, 10)
    engine.stop()
  })

  test('execDetails fills by orderRef (partial → filled)', async ({ assert }) => {
    await makeTicker('NVDA')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    await engine.start([])
    const state = await engine.placeOrder({ symbol: 'NVDA', side: 'BUY', quantity: 10 })

    fake.fire('execDetails', 1, { symbol: 'NVDA' }, {
      orderId: 100, orderRef: state.clientOrderId, cumQty: 4, avgPrice: 102,
    })
    assert.equal(state.status, 'partially_filled')
    assert.equal(state.filledQuantity, 4)

    fake.fire('execDetails', 1, { symbol: 'NVDA' }, {
      orderId: 100, orderRef: state.clientOrderId, cumQty: 10, avgPrice: 101.8,
    })
    assert.equal(state.status, 'filled')
    assert.equal(state.filledQuantity, 10)
    engine.stop()
  })

  test('commissionReport applies commission by permId', async ({ assert }) => {
    await makeTicker('AMD')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    await engine.start([])
    const state = await engine.placeOrder({ symbol: 'AMD', side: 'BUY', quantity: 10 })

    fake.fire('orderStatus', 100, 'Filled', 10, 0, 50, 4242)
    fake.fire('commissionReport', { permId: 4242, commission: 1.25, currency: 'USD' })
    assert.equal(state.commission, 1.25)
    assert.equal(state.commissionAsset, 'USD')
    engine.stop()
  })

  test('cancelOrder cancels on the venue and marks the state', async ({ assert }) => {
    await makeTicker('TSLA')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    await engine.start([])
    const state = await engine.placeOrder({ symbol: 'TSLA', side: 'BUY', quantity: 5 })

    const ok = await engine.cancelOrder(state.clientOrderId)
    assert.isTrue(ok)
    assert.deepEqual(fake.cancelled, [100])
    assert.equal(state.status, 'cancelled')
    engine.stop()
  })

  test('recovery rehydrates active orders from the DB and maps order ids', async ({ assert }) => {
    const ticker = await makeTicker('GOOGL')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)

    // Pre-existing active order from a previous run.
    await Trade.create({
      tickerId: ticker.id,
      symbol: 'GOOGL',
      side: 'BUY',
      orderType: 'MKT',
      quantity: 3,
      externalOrderId: '77',
      clientOrderId: 'recovered-1',
      status: 'submitted',
      broker: 'ibkr',
      exchange: 'SMART',
      currency: 'USD',
      timeInForce: 'DAY',
    })

    await engine.start([])
    const order = engine.getOrder('recovered-1')
    assert.isNotNull(order)
    assert.equal(order!.externalOrderId, '77')
    assert.equal(engine.getOrdersBySymbol('GOOGL').length, 1)

    // Order-status events map onto the recovered order.
    fake.fire('orderStatus', 77, 'Filled', 3, 0, 99.5, 9999)
    assert.equal(engine.getOrder('recovered-1')!.status, 'filled')
    await engine.stop()
  })

  test('pruneCompletedOrders drops old terminal states', async ({ assert }) => {
    await makeTicker('INTC')
    const fake = makeFakeIbkr()
    const engine = newEngine(fake.ibkr)
    await engine.start([])
    const state = await engine.placeOrder({ symbol: 'INTC', side: 'BUY', quantity: 1 })
    fake.fire('orderStatus', 100, 'Filled', 1, 0, 30, 1)
    await new Promise((r) => setTimeout(r, 5)) // ensure submittedAt is in the past

    assert.equal(engine.pruneCompletedOrders(0), 1)
    assert.isUndefined(engine.getOrder(state.clientOrderId))
    engine.stop()
  })
})