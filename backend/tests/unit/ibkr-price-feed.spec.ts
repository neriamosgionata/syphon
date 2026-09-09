import { test } from '@japa/runner'
import { IBKRPriceFeed } from '../../app/services/IBKRPriceFeed.js'

// IBKRPriceFeed maps app symbols → IBKR contracts (from the Ticker model)
// and delegates ticks to IBKRService's market-data layer. The ibkr facade
// is faked; the ticker model is faked to avoid the throwaway DB.

function fakeIbkr() {
  const subscribed: Array<{ symbol: string; contract: any }> = []
  const prices = new Map<string, number>()
  return {
    subscribed,
    prices,
    reqMktData: (symbol: string, contract: any) => {
      subscribed.push({ symbol, contract })
      prices.set(symbol, 1)
    },
    getMarketPrice: (s: string) => prices.get(s) ?? null,
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

test.group('IBKRPriceFeed', () => {
  test('addSymbol resolves the contract from the ticker row and subscribes', async ({ assert }) => {
    const ibkr = fakeIbkr()
    const feed = new IBKRPriceFeed({
      ibkr,
      tickerModel: fakeTickers({ AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' } }) as any,
    })

    feed.addSymbol('AAPL')
    await new Promise((r) => setTimeout(r, 10)) // let the async contract resolution land

    assert.deepEqual(ibkr.subscribed, [
      { symbol: 'AAPL', contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' } },
    ])
    assert.deepEqual(feed.getConnectedSymbols(), ['AAPL'])
    assert.equal(feed.getPrice('AAPL'), 1)
  })

  test('crypto secType maps to CRYPTO with PAXOS exchange', async ({ assert }) => {
    const ibkr = fakeIbkr()
    const feed = new IBKRPriceFeed({
      ibkr,
      tickerModel: fakeTickers({ BTC: { symbol: 'BTC', secType: 'crypto', exchange: 'KRAKEN', currency: 'USD' } }) as any,
    })

    feed.addSymbol('BTC')
    await new Promise((r) => setTimeout(r, 10))

    assert.deepEqual(ibkr.subscribed[0].contract, {
      symbol: 'BTC', secType: 'CRYPTO', exchange: 'KRAKEN', currency: 'USD',
    })
  })

  test('missing ticker row logs and never subscribes', async ({ assert }) => {
    const ibkr = fakeIbkr()
    const feed = new IBKRPriceFeed({ ibkr, tickerModel: fakeTickers({}) as any })

    feed.addSymbol('UNKNOWN')
    await new Promise((r) => setTimeout(r, 10))

    assert.equal(ibkr.subscribed.length, 0)
    assert.equal(feed.getPrice('UNKNOWN'), null)
  })

  test('addSymbol is idempotent', async ({ assert }) => {
    const ibkr = fakeIbkr()
    const feed = new IBKRPriceFeed({
      ibkr,
      tickerModel: fakeTickers({ AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' } }) as any,
    })

    feed.addSymbol('AAPL')
    feed.addSymbol('aapl')
    await new Promise((r) => setTimeout(r, 10))

    assert.equal(ibkr.subscribed.length, 1)
  })

  test('removeSymbol drops the subscription from the tracking set', async ({ assert }) => {
    const ibkr = fakeIbkr()
    const feed = new IBKRPriceFeed({
      ibkr,
      tickerModel: fakeTickers({ AAPL: { symbol: 'AAPL', secType: 'stock', exchange: null, currency: 'USD' } }) as any,
    })

    feed.addSymbol('AAPL')
    await new Promise((r) => setTimeout(r, 10))
    feed.removeSymbol('AAPL')

    assert.deepEqual(feed.getConnectedSymbols(), [])
  })
})