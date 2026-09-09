import { test } from '@japa/runner'
import { IBKRDataService } from '../../app/services/IBKRDataService.js'

// IBKRDataService maps intervals → bar sizes/durations and pages
// historical bars backward via getHistoricalBars. The ibkr facade is
// faked (returns bar arrays per endDateTime); tickers come from a fake.

const BAR = (time: number, close = 100): any => ({
  time, open: 99, high: 101, low: 98, close, volume: 1000,
})

function fakeIbkr(calls: any[] = []) {
  return {
    calls,
    async getHistoricalBars(opts: any) {
      calls.push(opts)
      const end = opts.endDateTime ? Date.parse(opts.endDateTime.replace(' ', 'T')) : Date.now()
      // Fake data: one bar per 60s ending at `end`, going back `duration`.
      const seconds = opts.duration === '3600 S' ? 3600 : 86400
      const bars: any[] = []
      for (let t = Math.floor(end / 1000) - seconds; t < Math.floor(end / 1000); t += 60) {
        bars.push(BAR(t, 100 + (t % 10)))
      }
      return bars
    },
  }
}

function fakeTickers(rows: Record<string, any>) {
  return {
    async findBy(field: string, value: string) {
      if (field !== 'symbol') return null
      return rows[value] ?? null
    },
  }
}

test.group('IBKRDataService', () => {
  test('getOHLC maps interval to bar size + duration and parses candles', async ({ assert }) => {
    const calls: any[] = []
    const service = new IBKRDataService(fakeIbkr(calls) as any, fakeTickers({
      AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' },
    }) as any)

    const { candles, lastTime } = await service.getOHLC('AAPL', 60)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].barSize, '1 min')
    assert.equal(calls[0].duration, '1 D')
    assert.equal(calls[0].contract.secType, 'STK')
    assert.equal(calls[0].contract.exchange, 'SMART')
    assert.isAbove(candles.length, 100)
    assert.isNotNull(lastTime)
  })

  test('1s bars use 3600-second chunks', async ({ assert }) => {
    const calls: any[] = []
    const service = new IBKRDataService(fakeIbkr(calls) as any, fakeTickers({
      AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' },
    }) as any)

    await service.getOHLC('AAPL', 1)
    assert.equal(calls[0].barSize, '1 secs')
    assert.equal(calls[0].duration, '3600 S')
  })

  test('unsupported intervals throw', async ({ assert }) => {
    const service = new IBKRDataService(fakeIbkr() as any, fakeTickers({
      AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' },
    }) as any)
    await assert.rejects(() => service.getOHLC('AAPL', 7), /Unsupported interval/)
  })

  test('missing ticker row throws', async ({ assert }) => {
    const service = new IBKRDataService(fakeIbkr() as any, fakeTickers({}) as any)
    await assert.rejects(() => service.getOHLC('UNKNOWN', 60), /No ticker row/)
  })

  test('walkOHLC pages back with endDateTime until the target start', async ({ assert }) => {
    const calls: any[] = []
    const service = new IBKRDataService(fakeIbkr(calls) as any, fakeTickers({
      AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' },
    }) as any)

    const now = Date.now()
    const targetStart = now - 3 * 24 * 3600_000 // 3 days ago — inside 5 daily pages
    const candles = await service.walkOHLC('AAPL', 60, targetStart, 5)

    assert.isAbove(calls.length, 1) // chunked backward
    assert.isAbove(candles.length, 1000)
    assert.isAtMost(candles[0].time * 1000, targetStart)
    // endDateTime paging: second call asks for data ending before the first.
    assert.isNotNull(calls[1]?.endDateTime)
  })

  test('empty responses stop the walk', async ({ assert }) => {
    let calls = 0
    const empty = {
      async getHistoricalBars() {
        calls++
        return []
      },
    }
    const service = new IBKRDataService(empty as any, fakeTickers({
      AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' },
    }) as any)

    const candles = await service.walkOHLC('AAPL', 60, 0, 5)
    assert.equal(candles.length, 0)
    assert.equal(calls, 1)
  })
})