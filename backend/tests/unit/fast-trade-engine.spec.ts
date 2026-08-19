import { test } from '@japa/runner'
import { FastTradeEngine } from '../../app/services/FastTradeEngine.js'
import type { ExecutionReport } from '../../app/services/BinanceWebSocketService.js'

// FastTradeEngine is a singleton over the Lucid Database + Binance REST/WS.
// These tests construct a fresh engine with a fake Database (better-sqlite3
// AND mysql response shapes) and a stubbed global fetch, exercising the
// dialect-safe SQL paths that were rewritten for SQLite support.

// The public surface stays fully typed; private members the tests manipulate
// are reachable through the loose index signature.
type TestableEngine = FastTradeEngine & { [key: string]: any }

let engine: TestableEngine
let fetchImpl: any

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

function stubFetch(json: any) {
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
  })
  ;(globalThis as any).fetch = fetchImpl
}

function stubFetchError() {
  fetchImpl = async () => {
    throw new Error('binance down')
  }
  ;(globalThis as any).fetch = fetchImpl
}

test.group('FastTradeEngine', (group) => {
  let db: FakeDb
  let defaultRawQuery: FakeDb['rawQuery']
  let defaultTransaction: FakeDb['transaction']
  const originalFetch = globalThis.fetch

  group.setup(async () => {
    db = createFakeDb()
    // The engine keeps the injected Database reference, so state must be
    // mutated on the SAME object; save the default method impls to restore
    // per test.
    defaultRawQuery = db.rawQuery
    defaultTransaction = db.transaction

    engine = new FastTradeEngine(db)
  })

  group.each.setup(() => {
    // Previous tests may have overridden rawQuery / transaction — restore
    // the defaults on the shared fake Database object.
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
    stubFetch({ orderId: 12345, status: 'NEW' })
  })

  group.each.teardown(() => {
    // Restore the real fetch so later suites (functional) still work.
    ;(globalThis as any).fetch = originalFetch
  })

  test('placeOrder maps Binance order types onto DB enum', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({
      symbol: 'BTC', side: 'BUY', quantity: 0.5, orderType: 'LIMIT', price: 60000,
    })
    assert.equal(state.orderType, 'LMT')
    assert.equal(state.status, 'submitted')
    assert.equal(state.externalOrderId, '12345')
    assert.equal(state.tickerId, 7)
  })

  test('placeOrder defaults unknown order types to MKT', async ({ assert }) => {
    db.tickerRows = [{ id: 1 }]
    const state = await engine.placeOrder({
      symbol: 'BTC', side: 'SELL', quantity: 1, orderType: 'OCO',
    })
    assert.equal(state.orderType, 'MKT')
  })

  test('placeOrder creates the ticker when it does not exist (SQLite insert)', async ({ assert }) => {
    // SELECT returns nothing -> engine falls back to INSERT OR IGNORE, then
    // SELECTs again and gets the freshly created row.
    let firstSelect = true
    db.rawQuery = async (sql: string) => {
      db.calls.push(sql)
      if (/^SELECT id FROM tickers/.test(sql)) {
        if (firstSelect) {
          firstSelect = false
          return []
        }
        return [{ id: 99 }]
      }
      if (/INSERT (OR IGNORE )?INTO tickers/.test(sql)) return { changes: 1 }
      return []
    }
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.1 })
    assert.equal(state.tickerId, 99)
    assert.isTrue(db.calls.some((sql) => /INSERT OR IGNORE INTO tickers/.test(sql)))
  })

  test('placeOrder without ticker resolution returns error state', async ({ assert }) => {
    db.rawQuery = async () => []
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.1 })
    assert.equal(state.status, 'error')
    assert.match(state.errorMessage ?? '', /ticker/i)
  })

  test('flushToDb inserts new trade rows via lastInsertRowid (SQLite)', async ({ assert }) => {
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
    assert.equal(params[2], 'BUY') // side
    assert.equal(params[4], 0.5) // quantity
    assert.equal(params[8], state.clientOrderId) // client_order_id
    assert.equal(params[14], 'binance') // broker
  })

  test('flushToDb updates rows via changes count and falls back to INSERT on 0 rows (SQLite)', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })
    state.tradeId = 10

    db.updateResult = { changes: 0 }
    db.insertResult = { lastInsertRowid: 777 }
    await engine['flushToDb']()

    // UPDATE matched nothing -> row was re-inserted and tradeId refreshed.
    assert.equal(state.tradeId, 777)
    assert.equal(db.insertedTrades.length, 1)
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

  test('handleExecutionReport applies FILLED report to matching order', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })

    engine['handleExecutionReport']({
      e: 'executionReport', E: 111, s: 'BTCUSDT', c: state.clientOrderId, S: 'BUY',
      o: 'MARKET', q: '0.5', p: '0', P: '0', x: 'TRADE', X: 'FILLED', r: 'NONE',
      i: 1, l: '0.5', z: '0.5', L: '60100.00', n: '1.2', N: 'BNB', T: 222, t: 2,
    })

    assert.equal(state.status, 'filled')
    assert.equal(state.filledQuantity, 0.5)
    assert.equal(state.fillPrice, 60100)
    assert.equal(state.commission, 1.2)
    assert.equal(state.commissionAsset, 'BNB')
    assert.equal(state.filledAt, 222)
    assert.isTrue(state.dirty)
  })

  test('handleExecutionReport maps NEW/PARTIALLY_FILLED/REJECTED statuses', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'ETH', side: 'BUY', quantity: 1 })

    const report = (X: string, z = '', L = ''): ExecutionReport => ({
      e: 'executionReport', E: 1, s: 'ETHUSDT', c: state.clientOrderId, S: 'BUY',
      o: 'MARKET', q: '1', p: '0', P: '0', x: 'TRADE', X, r: 'NONE',
      i: 1, l: '0', z, L, n: '0', N: null, T: 0, t: 0,
    })

    engine['handleExecutionReport'](report('NEW'))
    assert.equal(state.status, 'submitted')

    engine['handleExecutionReport'](report('PARTIALLY_FILLED', '0.3', '60000'))
    assert.equal(state.status, 'partially_filled')
    assert.equal(state.filledQuantity, 0.3)

    engine['handleExecutionReport'](report('REJECTED'))
    assert.equal(state.status, 'error')
  })

  test('handleExecutionReport ignores reports for unknown orders', async ({ assert }) => {
    engine['handleExecutionReport']({
      e: 'executionReport', E: 1, s: 'BTCUSDT', c: 'no-such-order', S: 'BUY',
      o: 'MARKET', q: '1', p: '0', P: '0', x: 'TRADE', X: 'FILLED', r: 'NONE',
      i: 1, l: '1', z: '1', L: '100', n: '0', N: null, T: 0, t: 0,
    })
    assert.equal(engine.getActiveOrderCount(), 0)
  })

  test('cancelOrder cancels an open order', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    const state = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })

    stubFetch({})
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
    assert.match(state.errorMessage ?? '', /binance down/)
  })

  test('getOrdersBySymbol is case insensitive', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 0.5 })
    const orders = engine.getOrdersBySymbol('btc')
    assert.equal(orders.length, 1)
  })

  test('pruneCompletedOrders removes only old completed orders', async ({ assert }) => {
    db.tickerRows = [{ id: 7 }]
    stubFetchError() // keep orders stuck in 'pending' for status control
    const oldFilled = await engine.placeOrder({ symbol: 'BTC', side: 'BUY', quantity: 1 })
    const newFilled = await engine.placeOrder({ symbol: 'ETH', side: 'BUY', quantity: 1 })
    const active = await engine.placeOrder({ symbol: 'SOL', side: 'BUY', quantity: 1 })

    oldFilled.status = 'filled'
    oldFilled.submittedAt = Date.now() - 7200000
    newFilled.status = 'filled'
    newFilled.submittedAt = Date.now() - 60000

    const removed = engine.pruneCompletedOrders(3600000)

    assert.equal(removed, 1)
    assert.isUndefined(engine.getOrder(oldFilled.clientOrderId))
    assert.isDefined(engine.getOrder(newFilled.clientOrderId))
    assert.isDefined(engine.getOrder(active.clientOrderId))
  })

  test('recoverFromDb restores active orders and reconciles with exchange', async ({ assert }) => {
    db.recoveredRows = [{
      id: 42, symbol: 'BTC', side: 'BUY', order_type: 'MKT', quantity: 0.5,
      limit_price: null, stop_price: null, external_order_id: '9999',
      client_order_id: 'recovered-1', status: 'submitted', filled_quantity: 0,
      fill_price: null, commission: null, submitted_at: '2026-08-01 12:00:00',
      error_message: null, ticker_id: 7,
    }]

    stubFetch({ status: 'FILLED', executedQty: '0.5', cummulativeQuoteQty: '30050', updateTime: 555 })
    await engine['recoverFromDb']()

    const state = engine.getOrder('recovered-1')
    assert.isDefined(state)
    assert.equal(state?.tradeId, 42)
    assert.equal(state?.externalOrderId, '9999')
    assert.equal(state?.status, 'filled')
    assert.equal(state?.filledQuantity, 0.5)
    assert.equal(state?.fillPrice, 60100) // 30050 / 0.5
    assert.equal(state?.filledAt, 555)
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