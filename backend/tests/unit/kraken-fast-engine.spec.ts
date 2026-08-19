import { test } from '@japa/runner'
import { KrakenFastEngine } from '../../app/services/KrakenFastEngine.js'
import type { KrakenOrderUpdate } from '../../app/services/KrakenWebSocketService.js'

// KrakenFastEngine is the in-memory fast engine (REST order placement + WS
// fills). These tests construct a fresh engine with a fake Database and a
// stubbed global fetch returning Kraken response shapes ({ result, error }).

type TestableEngine = KrakenFastEngine & { [key: string]: any }

let engine: TestableEngine

interface FakeDb {
  dialectName: string
  tickerRows: any[]
  recoveredRows: any[]
  updateResult: any
  insertResult: any
  insertedTrades: any[]
  lastInsertRowid: number
  calls: string[]
  rawQuery: (sql: string, params?: any[]) => Promise<any>
  transaction: () => Promise<any>
  connection: () => { dialect: { name: string } }
}

function createFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  const db: FakeDb = {
    dialectName: 'better-sqlite3',
    tickerRows: [],
    recoveredRows: [],
    updateResult: { changes: 1 },
    insertResult: { lastInsertRowid: 500 },
    insertedTrades: [],
    lastInsertRowid: 500,
    calls: [],
    rawQuery: async () => [],
    transaction: async () => ({ rawQuery: async () => ({}), commit: async () => {}, rollback: async () => {} }),
    connection: () => ({ dialect: { name: db.dialectName } }),
    ...overrides,
  }

  db.rawQuery = async (sql: string, _params: any[] = []) => {
    db.calls.push(sql)
    if (/^SELECT id FROM tickers/.test(sql)) return db.tickerRows
    if (/INSERT (OR IGNORE )?INTO tickers/.test(sql)) return { changes: 1 }
    if (/^\s*SELECT id, symbol, side/.test(sql)) return db.recoveredRows
    return []
  }

  db.transaction = async () => {
    const trx = {
      rawQuery: async (sql: string, params: any[] = []) => {
        db.calls.push(`trx: ${sql}`)
        if (/^\s*UPDATE trades/.test(sql)) {
          return db.updateResult
        }
        if (/^\s*INSERT INTO trades/.test(sql)) {
          db.insertedTrades.push(params)
          return db.insertResult
        }
        return {}
      },
      commit: async () => {},
      rollback: async () => {},
    }
    return trx
  }

  return db
}

const ADD_ORDER_OK = { result: { txid: ['KRAKEN-TXID-1'] }, error: [] }

function stubFetch(json: any) {
  ;(globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    json: async () => json,
  })
}

function stubFetchError() {
  ;(globalThis as any).fetch = async () => {
    throw new Error('kraken down')
  }
}

test.group('KrakenFastEngine', (group) => {
  let db: FakeDb
  let defaultRawQuery: FakeDb['rawQuery']
  let defaultTransaction: FakeDb['transaction']
  const originalFetch = globalThis.fetch

  group.setup(async () => {
    db = createFakeDb()
    defaultRawQuery = db.rawQuery
    defaultTransaction = db.transaction

    engine = new KrakenFastEngine(db)
  })

  group.each.setup(() => {
    db.rawQuery = defaultRawQuery
    db.transaction = defaultTransaction
    db.dialectName = 'better-sqlite3'
    db.tickerRows = []
    db.recoveredRows = []
    db.updateResult = { changes: 1 }
    db.insertResult = { lastInsertRowid: 500 }
    db.lastInsertRowid = 500
    db.insertedTrades = []
    db.calls = []
    engine['orders'].clear()
    engine['flushQueue'] = []
    engine['pendingFlushIds'] = new Set()
    engine['tickerIdCache'] = new Map()
    engine['flushing'] = false
    stubFetch(ADD_ORDER_OK)
  })

  group.each.teardown(() => {
    ;(globalThis as any).fetch = originalFetch
  })

  test('placeOrder maps Kraken order types onto DB enum and stores txid', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({
      symbol: 'BTC', side: 'BUY', quantity: 0.5, orderType: 'LIMIT', price: 60000,
    })
    assert.equal(state.orderType, 'LMT')
    assert.equal(state.status, 'submitted')
    assert.equal(state.externalOrderId, 'KRAKEN-TXID-1')
    assert.equal(state.tickerId, 7)
  })

  test('placeOrder defaults unknown order types to MKT', async ({ assert }) => {
    db.tickerRows = [{ id: 1 }]
    const state = await engine.placeOrder({
      symbol: 'BTC', side: 'SELL', quantity: 1, orderType: 'OCO',
    })
    assert.equal(state.orderType, 'MKT')
  })

  test('placeOrder without ticker resolution returns error state', async ({ assert }) => {
    db.rawQuery = async () => []
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.1 })
    assert.equal(state.status, 'error')
    assert.match(state.errorMessage ?? '', /ticker/i)
  })

  test('flushToDb inserts new trade rows tagged broker=kraken (SQLite)', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })
    assert.isNull(state.tradeId)

    await engine['flushToDb']()

    assert.equal(state.tradeId, 500)
    assert.isFalse(state.dirty)
    assert.equal(db.insertedTrades.length, 1)
    const params = db.insertedTrades[0]
    assert.equal(params[0], 7) // ticker_id
    assert.equal(params[1], 'BTC') // symbol
    assert.equal(params[8], state.clientOrderId) // client_order_id
    assert.equal(params[14], 'kraken') // broker
    assert.equal(params[16], 'USD') // currency
  })

  test('flushToDb re-queues the batch when persistence fails', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    db.transaction = async () => {
      throw new Error('db locked')
    }
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })

    await engine['flushToDb']()

    assert.equal(engine['flushQueue'].length, 1)
    assert.equal(engine['flushQueue'][0].clientOrderId, state.clientOrderId)
  })

  test('handleOrderUpdate applies closed order with full fill data', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })

    engine['handleOrderUpdate']({
      txid: 'KRAKEN-TXID-1',
      cl_ord_id: state.clientOrderId,
      status: 'closed',
      vol: '0.5',
      vol_exec: '0.5',
      avg_price: '60100',
      fee: '1.2',
      lastupdated: '1787000000',
    })

    assert.equal(state.status, 'filled')
    assert.equal(state.filledQuantity, 0.5)
    assert.equal(state.fillPrice, 60100)
    assert.equal(state.commission, 1.2)
    assert.equal(state.commissionAsset, 'USD')
    assert.equal(state.filledAt, 1787000000000)
    assert.isTrue(state.dirty)
  })

  test('handleOrderUpdate maps open/partial/canceled statuses', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'ETH', side: 'BUY', quantity: 1 })

    const update = (status: string, vol = '1', volExec = '0'): KrakenOrderUpdate => ({
      txid: 'KRAKEN-TXID-1',
      cl_ord_id: state.clientOrderId,
      status,
      vol,
      vol_exec: volExec,
    })

    engine['handleOrderUpdate'](update('open', '1', '0'))
    assert.equal(state.status, 'submitted')

    engine['handleOrderUpdate'](update('open', '1', '0.3'))
    assert.equal(state.status, 'partially_filled')
    assert.equal(state.filledQuantity, 0.3)

    engine['handleOrderUpdate'](update('open', '1', '1'))
    assert.equal(state.status, 'filled')

    const cancelled = await engine.placeOrder({ symbol: 'SOL', side: 'BUY', quantity: 1 })
    engine['handleOrderUpdate']({ txid: 'X', cl_ord_id: cancelled.clientOrderId, status: 'canceled' })
    assert.equal(cancelled.status, 'cancelled')
  })

  test('handleOrderUpdate ignores updates for unknown orders', async ({ assert }) => {
    engine['handleOrderUpdate']({ txid: 'X', cl_ord_id: 'no-such-order', status: 'closed' })
    assert.equal(engine.getActiveOrderCount(), 0)
  })

  test('status-only closed update triggers REST backfill of fills', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })

    // Close arrives without vol_exec (status-only) -> status flips synchronously.
    engine['handleOrderUpdate']({ txid: 'KRAKEN-TXID-1', cl_ord_id: state.clientOrderId, status: 'closed' })
    assert.equal(state.status, 'filled')

    // Backfill pulled from REST QueryOrders.
    stubFetch({ result: { 'KRAKEN-TXID-1': { status: 'closed', vol_exec: '0.5', avg_price: '60100', fee: '1.2' } }, error: [] })
    await engine['reconcileOne'](state)

    assert.equal(state.filledQuantity, 0.5)
    assert.equal(state.fillPrice, 60100)
    assert.equal(state.commission, 1.2)
  })

  test('cancelOrder cancels an open order', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })

    stubFetch({ result: {}, error: [] })
    const cancelled = await engine.cancelOrder(state.clientOrderId)

    assert.isTrue(cancelled)
    assert.equal(state.status, 'cancelled')
    assert.isNumber(state.cancelledAt)
  })

  test('cancelOrder refuses filled, cancelled, error and unknown orders', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })
    state.status = 'filled'

    assert.isFalse(await engine.cancelOrder(state.clientOrderId))
    assert.isFalse(await engine.cancelOrder('does-not-exist'))
  })

  test('placeOrder with exchange failure leaves error state with message', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    stubFetchError()
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })
    assert.equal(state.status, 'error')
    assert.match(state.errorMessage ?? '', /kraken down/)
  })

  test('getOrdersBySymbol is case insensitive', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })
    const orders = engine.getOrdersBySymbol('btc')
    assert.equal(orders.length, 1)
  })

  test('pruneCompletedOrders removes only old completed orders', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    stubFetchError()
    const oldFilled = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 1 })
    const newFilled = await engine.placeOrder({ symbol: 'ETH', side: 'BUY', quantity: 1 })

    oldFilled.status = 'filled'
    oldFilled.submittedAt = Date.now() - 7200000
    newFilled.status = 'filled'
    newFilled.submittedAt = Date.now() - 60000

    const removed = engine.pruneCompletedOrders(3600000)

    assert.equal(removed, 1)
    assert.isUndefined(engine.getOrder(oldFilled.clientOrderId))
    assert.isDefined(engine.getOrder(newFilled.clientOrderId))
  })

  test('recoverFromDb restores active orders and reconciles with exchange', async ({ assert }) => {
    db.recoveredRows = [{
      id: 42, symbol: 'BTC', side: 'BUY', order_type: 'MKT', quantity: 0.5,
      limit_price: null, stop_price: null, external_order_id: '9999',
      client_order_id: 'recovered-1', status: 'submitted', filled_quantity: 0,
      fill_price: null, commission: null, submitted_at: '2026-08-01 12:00:00',
      error_message: null, ticker_id: 7,
    }]

    stubFetch({ result: { '9999': { status: 'closed', vol_exec: '0.5', avg_price: '60100', fee: '1.2' } }, error: [] })
    await engine['recoverFromDb']()

    const state = engine.getOrder('recovered-1')
    assert.isDefined(state)
    assert.equal(state?.tradeId, 42)
    assert.equal(state?.externalOrderId, '9999')
    assert.equal(state?.status, 'filled')
    assert.equal(state?.filledQuantity, 0.5)
    assert.equal(state?.fillPrice, 60100)
    assert.equal(state?.commission, 1.2)
  })

  test('recoverFromDb skips rows without external order ids', async ({ assert }) => {
    db.recoveredRows = [{ id: 1, symbol: 'BTC', external_order_id: null, client_order_id: null }]
    await engine['recoverFromDb']()
    assert.equal(engine.getAllOrders().length, 0)
  })

  test('start() without API keys does not start the engine', async ({ assert }) => {
    await engine.start(['BTC'])
    assert.isFalse(engine.running)
  })
})
