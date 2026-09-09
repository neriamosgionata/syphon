import { test } from '@japa/runner'
import { aggregateTradesToBars, TickRecorderService } from '../../app/services/TickRecorderService.js'
import { KrakenWSTrade } from '../../app/services/KrakenWebSocketService.js'

// TickRecorder: 1s OHLCV aggregation (pure) + listener wiring with a fake
// WS. DB flush is integration territory (real SQLite) — the unit surface is
// aggregation correctness and buffer behavior.

const trade = (overrides: Partial<KrakenWSTrade> = {}): KrakenWSTrade => ({
  symbol: 'BTC',
  price: 100,
  volume: 1,
  time: 1700000000,
  side: 'buy',
  ordertype: 'market',
  ...overrides,
})

test.group('aggregateTradesToBars', () => {
  test('single trade produces one bar with flat OHLC', ({ assert }) => {
    const bars = aggregateTradesToBars([trade({ price: 100.5, volume: 0.25 })], 'BTC')
    assert.equal(bars.length, 1)
    assert.equal(bars[0].ts, 1700000000 * 1000)
    assert.equal(bars[0].open, 100.5)
    assert.equal(bars[0].high, 100.5)
    assert.equal(bars[0].low, 100.5)
    assert.equal(bars[0].close, 100.5)
    assert.equal(bars[0].volume, 0.25)
  })

  test('multiple trades in one second aggregate OHLCV', ({ assert }) => {
    const bars = aggregateTradesToBars([
      trade({ price: 100, volume: 1 }),
      trade({ price: 101, volume: 2 }),
      trade({ price: 99, volume: 3 }),
      trade({ price: 100.5, volume: 4 }),
    ], 'BTC')
    assert.equal(bars.length, 1)
    assert.equal(bars[0].open, 100)
    assert.equal(bars[0].high, 101)
    assert.equal(bars[0].low, 99)
    assert.equal(bars[0].close, 100.5)
    assert.equal(bars[0].volume, 10)
  })

  test('trades across seconds produce sorted separate bars', ({ assert }) => {
    const bars = aggregateTradesToBars([
      trade({ time: 1700000001, price: 102 }),
      trade({ time: 1700000000, price: 100 }),
      trade({ time: 1700000000, price: 101 }),
    ], 'BTC')
    assert.equal(bars.length, 2)
    assert.equal(bars[0].ts, 1700000000 * 1000)
    assert.equal(bars[1].ts, 1700000001 * 1000)
    assert.equal(bars[0].close, 101)
    assert.equal(bars[1].open, 102)
  })

  test('empty input yields no bars', ({ assert }) => {
    assert.equal(aggregateTradesToBars([]).length, 0)
  })

  test('symbol from the trade is used when not given', ({ assert }) => {
    const bars = aggregateTradesToBars([trade({ symbol: 'ETH', price: 3000 })])
    assert.equal(bars[0].symbol, 'ETH')
  })
})

test.group('TickRecorderService', () => {
  test('start subscribes trade listeners and buffers incoming trades', async ({ assert }) => {
    const listeners = new Map<string, (t: KrakenWSTrade) => void>()
    const fakeWs = {
      addTradeSymbol: (s: string) => { fakeWs.subscribed.add(s) },
      subscribed: new Set<string>(),
      onTrade: (symbol: string, cb: (t: KrakenWSTrade) => void) => {
        listeners.set(symbol, cb)
        return () => listeners.delete(symbol)
      },
    }
    const service = new TickRecorderService(fakeWs as any)
    service.start(['BTC', 'ETH'])
    service.addSymbol('BTC') // idempotent

    assert.isTrue(service.running)
    assert.equal(fakeWs.subscribed.size, 2)
    assert.deepEqual([...fakeWs.subscribed].sort(), ['BTC', 'ETH'])

    listeners.get('BTC')!(trade({ price: 100 }))
    listeners.get('BTC')!(trade({ price: 101, volume: 2 }))
    listeners.get('ETH')!(trade({ symbol: 'ETH', price: 3000 }))

    const status = service.status()
    assert.equal(status.bufferedBars['BTC'], 1)
    assert.equal(status.bufferedBars['ETH'], 1)

    service.stop()
    assert.isFalse(service.running)
  })

  test('buffer keeps one bar per second (later trades update it)', async ({ assert }) => {
    const listeners = new Map<string, (t: KrakenWSTrade) => void>()
    const fakeWs = {
      addTradeSymbol: () => {},
      onTrade: (_s: string, cb: (t: KrakenWSTrade) => void) => { listeners.set('BTC', cb); return () => {} },
    }
    const service = new TickRecorderService(fakeWs as any)
    service.start(['BTC'])

    listeners.get('BTC')!(trade({ time: 1700000000, price: 100 }))
    listeners.get('BTC')!(trade({ time: 1700000000, price: 102 }))
    listeners.get('BTC')!(trade({ time: 1700000001, price: 101 }))

    assert.equal(service.status().bufferedBars['BTC'], 2)
    service.stop()
  })

  test('trades for unsubscribed symbols are ignored', async ({ assert }) => {
    let cb: ((t: KrakenWSTrade) => void) | null = null
    const fakeWs = {
      addTradeSymbol: () => {},
      onTrade: (_s: string, handler: (t: KrakenWSTrade) => void) => { cb = handler; return () => {} },
    }
    const service = new TickRecorderService(fakeWs as any)
    service.start(['BTC'])

    cb!(trade({ symbol: 'SOL', price: 50 })) // recorder only listens for BTC
    assert.deepEqual(service.status().bufferedBars, {})
    service.stop()
  })
})