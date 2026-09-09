import { test } from '@japa/runner'
import { KrakenDataService, KrakenCandle } from '../../app/services/KrakenDataService.js'

// KrakenDataService hits the public REST API via global fetch. Tests stub
// fetch with Kraken response shapes ({ result, error }) — same pattern as
// kraken-fast-engine.spec. The throttle (1.1s spacing) is disabled by
// stubbing the private timing via a fresh instance + direct call order.

const OHLC_ROWS = [
  [1700000000, '100.0', '101.0', '99.5', '100.5', '100.0', '12.5', 42],
  [1700000060, '100.5', '102.0', '100.0', '101.5', '101.0', '8.0', 30],
]

const TRADE_ROWS = [
  ['100.5', '0.10', '1700000000', 'b', 'l', 'misc1'],
  ['101.0', '0.05', '1700000060', 's', 'm', 'misc2'],
]

function stubFetch(sequence: any[]) {
  let i = 0
  ;(globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => sequence[i++],
  })
  return () => { i = 0 }
}

const originalFetch = globalThis.fetch

test.group('KrakenDataService OHLC', () => {
  test('parses OHLC rows into candles', async ({ assert }) => {
    stubFetch([{ result: { XBTUSD: OHLC_ROWS, last: '1700000061' }, error: [] }])
    const service = new KrakenDataService((s) => (s === 'BTC' ? 'XBTUSD' : `${s}USD`))
    const { candles, lastTime } = await service.getOHLC('BTC', 1)

    assert.equal(candles.length, 2)
    assert.closeTo(candles[0].open, 100.0, 1e-9)
    assert.closeTo(candles[0].high, 101.0, 1e-9)
    assert.closeTo(candles[0].low, 99.5, 1e-9)
    assert.closeTo(candles[0].close, 100.5, 1e-9)
    assert.closeTo(candles[0].volume, 12.5, 1e-9)
    assert.equal(lastTime, 1700000061)
    ;(globalThis as any).fetch = originalFetch
  })

  test('walkOHLC pages back until the target start', async ({ assert }) => {
    // Page 1: newest candles; page 2: older (before target).
    const page1: any[][] = [[1700003600, '110', '111', '109', '110', '110', '1', 1]]
    const page2: any[][] = [[1699994000, '100', '101', '99', '100', '100', '1', 1]]
    const calls: string[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      calls.push(url)
      const since = url.match(/since=(\d+)/)
      const rows = since ? page2 : page1
      return { ok: true, json: async () => ({ result: { XBTUSD: rows, last: String(rows[0][0]) }, error: [] }) }
    }
    const service = new KrakenDataService(() => 'XBTUSD')
    const candles = await service.walkOHLC('BTC', 1, 1699994000 * 1000, 5)

    assert.equal(candles.length, 2)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /since=1700003600/)
    ;(globalThis as any).fetch = originalFetch
  })

  test('empty result stops the walk', async ({ assert }) => {
    let calls = 0
    ;(globalThis as any).fetch = async () => {
      calls++
      return { ok: true, json: async () => ({ result: { XBTUSD: [], last: null }, error: [] }) }
    }
    const service = new KrakenDataService(() => 'XBTUSD')
    const candles = await service.walkOHLC('BTC', 1, 0, 5)
    assert.equal(candles.length, 0)
    assert.equal(calls, 1)
    ;(globalThis as any).fetch = originalFetch
  })
})

test.group('KrakenDataService Trades', () => {
  test('parses trade rows', async ({ assert }) => {
    stubFetch([{ result: { XBTUSD: TRADE_ROWS, last: '98765' }, error: [] }])
    const service = new KrakenDataService(() => 'XBTUSD')
    const { trades, lastTradeId } = await service.getTrades('BTC')

    assert.equal(trades.length, 2)
    assert.closeTo(trades[0].price, 100.5, 1e-9)
    assert.equal(trades[0].side, 'buy')
    assert.equal(trades[0].ordertype, 'limit')
    assert.equal(trades[1].side, 'sell')
    assert.equal(trades[1].ordertype, 'market')
    assert.equal(lastTradeId, '98765')
    ;(globalThis as any).fetch = originalFetch
  })

  test('walkTrades pages back until the target start', async ({ assert }) => {
    const page1: any[][] = [[101, 0.1, 1700003600, 'b', 'm', 'x']]
    const page2: any[][] = [[100, 0.2, 1699994000, 'b', 'm', 'x']]
    const calls: string[] = []
    ;(globalThis as any).fetch = async (url: string) => {
      calls.push(url)
      const since = url.match(/since=(\d+)/)
      const rows = since ? page2 : page1
      return { ok: true, json: async () => ({ result: { XBTUSD: rows, last: since ? '2' : '1' }, error: [] }) }
    }
    const service = new KrakenDataService(() => 'XBTUSD')
    const trades = await service.walkTrades('BTC', 1699994000 * 1000, 5)

    // Ascending (oldest first): page2's trade first, then page1's.
    assert.equal(trades.length, 2)
    assert.equal(trades[0].time, 1699994000)
    assert.equal(trades[1].time, 1700003600)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /since=1/)
    ;(globalThis as any).fetch = originalFetch
  })

  test('rate-limit errors retry then succeed', async ({ assert }) => {
    let calls = 0
    ;(globalThis as any).fetch = async () => {
      calls++
      if (calls === 1) {
        return { ok: true, json: async () => ({ result: null, error: ['EAPI:Rate limit exceeded'] }) }
      }
      return { ok: true, json: async () => ({ result: { XBTUSD: TRADE_ROWS, last: '1' }, error: [] }) }
    }
    const service = new KrakenDataService(() => 'XBTUSD')
    const { trades } = await service.getTrades('BTC')
    assert.equal(trades.length, 2)
    assert.isAbove(calls, 1)
    ;(globalThis as any).fetch = originalFetch
  })

  test('non-rate-limit errors throw', async ({ assert }) => {
    ;(globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ result: null, error: ['EGeneral:Invalid arguments'] }),
    })
    const service = new KrakenDataService(() => 'XBTUSD')
    await assert.rejects(() => service.getTrades('BTC'), /Invalid arguments/)
    ;(globalThis as any).fetch = originalFetch
  })
})

test.group('KrakenDataService pair mapping', () => {
  test('default pairFn maps BTC to XBTUSD', async ({ assert }) => {
    ;(globalThis as any).fetch = async (url: string) => {
      assert.match(url, /pair=XBTUSD/)
      return { ok: true, json: async () => ({ result: { XBTUSD: [], last: null }, error: [] }) }
    }
    const service = new KrakenDataService()
    await service.getOHLC('BTC', 1)
    ;(globalThis as any).fetch = originalFetch
  })
})