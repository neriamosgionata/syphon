import { test } from '@japa/runner'
import { installIocHooks, restoreIocHooks, createRedisStub } from './helpers/ioc-hooks'

let originalIocHooks: any = null

let GoogleFinanceService: any

// Sample HTML fragments for mocking Google Finance responses
const QUOTE_PAGE_HTML = `
<html>
<head><title>Apple Inc Stock Price - Google Finance</title></head>
<body>
  <div class="zzDege">Apple Inc</div>
  <div data-last-price="189.84" data-currency-code="USD">$189.84</div>
  <div class="gyFHrc">
    <div class="mfs7Fc">52-week range</div>
    <div class="P6K39c">142.00 - 199.62</div>
  </div>
  <div class="gyFHrc">
    <div class="mfs7Fc">Market cap</div>
    <div class="P6K39c">2.95T</div>
  </div>
  <div class="gyFHrc">
    <div class="mfs7Fc">P/E ratio</div>
    <div class="P6K39c">31.25</div>
  </div>
  <div class="gyFHrc">
    <div class="mfs7Fc">Dividend yield</div>
    <div class="P6K39c">0.52%</div>
  </div>
  <div class="gyFHrc">
    <div class="mfs7Fc">Avg volume</div>
    <div class="P6K39c">54.2M</div>
  </div>
</body>
</html>
`

const QUOTE_PAGE_NO_PRICE_HTML = `
<html>
<head><title>Unknown - Google Finance</title></head>
<body><div>No data available</div></body>
</html>
`

const SEARCH_PAGE_HTML = `
<html>
<body>
  <div>
    <a href="/finance/quote/AAPL:NASDAQ">
      AAPL
      Apple Inc
      NASDAQ
    </a>
    <a href="/finance/quote/AAPL:NASDAQ">
      AAPL
      Apple Inc
      NASDAQ
    </a>
    <a href="/finance/quote/AAPD:NYSEARCA">
      AAPD
      Direxion Daily AAPL Bear 1X Shares
      NYSEARCA
    </a>
  </div>
</body>
</html>
`

const SEARCH_EMPTY_HTML = `
<html><body><div>No results found</div></body></html>
`

const SEARCH_CALLBACK_HTML = `
<html><body>
<script>
AF_initDataCallback({key: 'ds:1', data: [["MSFT","Microsoft Corporation","NASDAQ"],["MSFX","Some Fund","NYSE"]]});
</script>
</body></html>
`

const HISTORICAL_WITH_DATA_HTML = `
<html><body>
<script>
AF_initDataCallback({key: 'ds:5', data: [[1704067200,185.50,186.70,184.30,186.00,45000000],[1704153600,186.20,188.00,185.80,187.50,52000000],[1704240000,187.80,189.00,187.00,188.90,48000000]]});
</script>
</body></html>
`

const HISTORICAL_WINDOW_DATA_HTML = `
<html><body>
<script>
window.chartData = {"prices":[{"timestamp":1704067200,"open":185.5,"high":186.7,"low":184.3,"close":186.0,"volume":45000000},{"timestamp":1704153600,"open":186.2,"high":188.0,"low":185.8,"close":187.5,"volume":52000000}]};
</script>
</body></html>
`

const HISTORICAL_NO_DATA_HTML = `
<html><body><div>Quote page with no embedded chart data</div></body></html>
`

const QUOTE_DATA_ATTRID_HTML = `
<html>
<head><title>Tesla Inc Stock Price - Google Finance</title></head>
<body>
  <div data-last-price="245.30">$245.30</div>
  <div data-attrid="stock_52_week_range">124.50 - 278.98</div>
</body>
</html>
`

const QUOTE_HEADING_FALLBACK_HTML = `
<html>
<head><title>NVDA Stock Price - Google Finance</title></head>
<body>
  <div data-last-price="880.00">$880.00</div>
  <div data-tab-id="summary"><h1>NVIDIA Corporation</h1></div>
</body>
</html>
`

// Stub model class for Ticker and TickerSnapshot
function createModelStub() {
  return {
    findBy: async () => null,
    create: async (data: any) => ({ ...data, id: 1 }),
    query: () => ({
      where: function () { return this },
      preload: function () { return this },
      orderBy: function () { return this },
      limit: function () { return this },
      first: async () => null,
      firstOrFail: async () => ({ id: 1, symbol: 'TEST', snapshots: [] }),
    }),
  }
}

test.group('GoogleFinanceService', (group) => {
  let originalFetchHTML: any
  let originalFetchHistoricalFromStooq: any
  group.setup(async () => {
    const { Application } = await import('@adonisjs/application')
    const app = new Application(__dirname, 'test', {})

    // Mock Logger
    app.container.singleton('Adonis/Core/Logger', () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }))

    // Mock Env
    // NOTE: MEILI_* must mirror the real environment. The MeilisearchService
    // singleton is constructed at import time (module cache) and later reused
    // by the functional suite in the same process — poisoning it here with a
    // stub key breaks every Meili-backed endpoint there.
    app.container.singleton('Adonis/Core/Env', () => ({
      get: (key: string, defaultVal?: string) => {
        const vals: Record<string, string> = {
          FINANCE_PROVIDER: 'google',
          MEILI_URL: process.env.MEILI_URL || 'http://localhost:7700',
          MEILI_KEY: process.env.MEILI_KEY || '',
        }
        return vals[key] ?? defaultVal ?? ''
      },
    }))

    // Mock Redis (MeilisearchService does Redis.incr for id generation)
    app.container.singleton('Adonis/Addons/Redis', () => createRedisStub())

    // Mock the models so IoC resolution works
    const tickerStub = createModelStub()
    const snapshotStub = createModelStub()
    app.container.singleton('App/Models/Ticker', () => tickerStub)
    app.container.singleton('App/Models/TickerSnapshot', () => snapshotStub)

    originalIocHooks = installIocHooks(app)

    GoogleFinanceService = (await import('../../app/Services/GoogleFinanceService')).default
    originalFetchHTML = GoogleFinanceService['fetchHTML'].bind(GoogleFinanceService)
    originalFetchHistoricalFromStooq = GoogleFinanceService['fetchHistoricalFromStooq'].bind(GoogleFinanceService)
  })

  group.each.setup(() => {
    // Reset exchange cache before each test
    GoogleFinanceService['exchangeCache'].clear()
  })

  group.each.teardown(() => {
    GoogleFinanceService['fetchHTML'] = originalFetchHTML
    GoogleFinanceService['fetchHistoricalFromStooq'] = originalFetchHistoricalFromStooq
  })

  // --- fetchQuote tests ---

  group.teardown(() => restoreIocHooks(originalIocHooks))

  test('fetchQuote extracts price from data-last-price attribute', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.isNotNull(quote)
    assert.equal(quote.regularMarketPrice, 189.84)
    assert.equal(quote.symbol, 'AAPL')
  })

  test('fetchQuote extracts company name from page title', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.isNotNull(quote)
    assert.equal(quote.shortName, 'Apple Inc')
  })

  test('fetchQuote extracts name from heading when title matches symbol', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_HEADING_FALLBACK_HTML
    GoogleFinanceService['exchangeCache'].set('NVDA', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('NVDA')

    assert.isNotNull(quote)
    assert.equal(quote.shortName, 'NVIDIA Corporation')
    assert.equal(quote.regularMarketPrice, 880.00)
  })

  test('fetchQuote extracts 52-week range from stat rows', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.equal(quote.fiftyTwoWeekLow, 142.00)
    assert.equal(quote.fiftyTwoWeekHigh, 199.62)
  })

  test('fetchQuote extracts 52-week range from data-attrid attribute', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_DATA_ATTRID_HTML
    GoogleFinanceService['exchangeCache'].set('TSLA', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('TSLA')

    assert.isNotNull(quote)
    assert.equal(quote.regularMarketPrice, 245.30)
    assert.equal(quote.fiftyTwoWeekLow, 124.50)
    assert.equal(quote.fiftyTwoWeekHigh, 278.98)
  })

  test('fetchQuote parses market cap with T suffix', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.equal(quote.marketCap, 2.95e12)
  })

  test('fetchQuote extracts P/E ratio', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.equal(quote.trailingPE, 31.25)
  })

  test('fetchQuote computes EPS from price and P/E', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.isNotNull(quote.epsTrailingTwelveMonths)
    assert.closeTo(quote.epsTrailingTwelveMonths, 189.84 / 31.25, 0.01)
  })

  test('fetchQuote extracts dividend yield as decimal', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.closeTo(quote.dividendYield, 0.0052, 0.0001)
  })

  test('fetchQuote extracts average volume', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.equal(quote.averageDailyVolume3Month, 54.2e6)
  })

  test('fetchQuote returns null when no price found', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_NO_PRICE_HTML
    GoogleFinanceService['exchangeCache'].set('FAKE', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('FAKE')

    assert.isNull(quote)
  })

  test('fetchQuote returns null on fetch error', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => { throw new Error('Network error') }
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.isNull(quote)
  })

  test('fetchQuote returns complete structure with all expected fields', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.properties(quote, [
      'symbol',
      'shortName',
      'longName',
      'exchange',
      'regularMarketPrice',
      'marketCap',
      'fiftyTwoWeekHigh',
      'fiftyTwoWeekLow',
      'averageDailyVolume3Month',
      'trailingPE',
      'epsTrailingTwelveMonths',
      'dividendYield',
    ])
  })

  test('fetchQuote uppercases symbol', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML
    GoogleFinanceService['exchangeCache'].set('AAPL', 'NASDAQ')

    const quote = await GoogleFinanceService.fetchQuote('aapl')

    assert.equal(quote.symbol, 'AAPL')
  })

  // --- searchTicker tests ---

  test('searchTicker extracts results from quote links', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => SEARCH_PAGE_HTML

    const results = await GoogleFinanceService.searchTicker('AAPL')

    assert.isArray(results)
    assert.isTrue(results.length >= 1)
    assert.equal(results[0].symbol, 'AAPL')
    assert.equal(results[0].exchange, 'NASDAQ')
  })

  test('searchTicker deduplicates results', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => SEARCH_PAGE_HTML

    const results = await GoogleFinanceService.searchTicker('AAPL')

    const aaplResults = results.filter((r: any) => r.symbol === 'AAPL' && r.exchange === 'NASDAQ')
    assert.equal(aaplResults.length, 1)
  })

  test('searchTicker returns multiple distinct results', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => SEARCH_PAGE_HTML

    const results = await GoogleFinanceService.searchTicker('AAPL')

    assert.isTrue(results.length >= 2)
    const symbols = results.map((r: any) => r.symbol)
    assert.include(symbols, 'AAPL')
    assert.include(symbols, 'AAPD')
  })

  test('searchTicker falls back to AF_initDataCallback parsing', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => SEARCH_CALLBACK_HTML

    const results = await GoogleFinanceService.searchTicker('MSFT')

    assert.isTrue(results.length >= 1)
    assert.equal(results[0].symbol, 'MSFT')
    assert.equal(results[0].name, 'Microsoft Corporation')
    assert.equal(results[0].exchange, 'NASDAQ')
  })

  test('searchTicker returns empty array for no results', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => SEARCH_EMPTY_HTML

    const results = await GoogleFinanceService.searchTicker('XYZXYZ')

    assert.isArray(results)
    assert.lengthOf(results, 0)
  })

  test('searchTicker returns empty array on fetch error', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => { throw new Error('Network error') }

    const results = await GoogleFinanceService.searchTicker('AAPL')

    assert.isArray(results)
    assert.lengthOf(results, 0)
  })

  test('searchTicker limits results to 10', async ({ assert }) => {
    const links = Array.from({ length: 15 }, (_, i) => {
      const sym = `SYM${String(i).padStart(2, '0')}`
      return `<a href="/finance/quote/${sym}:NYSE">${sym}\nCompany ${i}\nNYSE</a>`
    }).join('\n')
    GoogleFinanceService['fetchHTML'] = async () => `<html><body>${links}</body></html>`

    const results = await GoogleFinanceService.searchTicker('SYM')

    assert.isTrue(results.length <= 10)
  })

  // --- fetchHistorical tests ---

  test('fetchHistorical extracts bars from AF_initDataCallback data', async ({ assert }) => {
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return HISTORICAL_WITH_DATA_HTML
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isArray(bars)
    assert.isTrue(bars.length > 0)
    bars.forEach((bar: any) => {
      assert.properties(bar, ['date', 'open', 'high', 'low', 'close', 'volume'])
      assert.instanceOf(bar.date, Date)
      assert.isNumber(bar.open)
      assert.isNumber(bar.high)
      assert.isNumber(bar.low)
      assert.isNumber(bar.close)
      assert.isNumber(bar.volume)
    })
  })

  test('fetchHistorical extracts multiple bars from AF_initDataCallback', async ({ assert }) => {
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return HISTORICAL_WITH_DATA_HTML
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isArray(bars)
    assert.equal(bars.length, 3)
    assert.closeTo(bars[0].open, 185.5, 0.01)
    assert.closeTo(bars[2].close, 188.9, 0.01)
  })

  test('fetchHistorical returns sorted bars by date ascending', async ({ assert }) => {
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return HISTORICAL_WITH_DATA_HTML
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    for (let i = 1; i < bars.length; i++) {
      assert.isTrue(bars[i].date.getTime() >= bars[i - 1].date.getTime())
    }
  })

  test('fetchHistorical filters bars by period1 start date', async ({ assert }) => {
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return HISTORICAL_WITH_DATA_HTML
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2030-01-01')

    assert.isArray(bars)
    assert.lengthOf(bars, 0)
  })

  test('fetchHistorical returns empty array when no data is embedded', async ({ assert }) => {
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return HISTORICAL_NO_DATA_HTML
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isArray(bars)
    assert.lengthOf(bars, 0)
  })

  test('fetchHistorical returns empty array on fetch error', async ({ assert }) => {
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async () => { throw new Error('Network error') }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isArray(bars)
    assert.lengthOf(bars, 0)
  })

  // --- exchange cache tests ---

  test('fetchQuote caches exchange for subsequent calls', async ({ assert }) => {
    let fetchCount = 0
    GoogleFinanceService['fetchHTML'] = async () => {
      fetchCount++
      return QUOTE_PAGE_HTML
    }

    // First call: tries exchanges until one works
    const quote1 = await GoogleFinanceService.fetchQuote('AAPL')
    const firstFetchCount = fetchCount

    // Second call: uses cached exchange, only 1 fetch
    const quote2 = await GoogleFinanceService.fetchQuote('AAPL')

    assert.isNotNull(quote1)
    assert.isNotNull(quote2)
    assert.equal(fetchCount, firstFetchCount + 1) // only 1 more fetch (cached exchange)
  })

  test('fetchQuote returns null when no exchange works', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_NO_PRICE_HTML

    const quote = await GoogleFinanceService.fetchQuote('XYZXYZ')

    assert.isNull(quote)
  })

  test('fetchQuote returns null on all fetch errors', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async () => { throw new Error('fail') }

    const quote = await GoogleFinanceService.fetchQuote('AAPL')

    assert.isNull(quote)
  })

  // --- parsePrice / parseMarketCap (tested indirectly through fetchQuote) ---

  test('market cap parsing handles B suffix', async ({ assert }) => {
    const html = QUOTE_PAGE_HTML.replace('2.95T', '150.3B')
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('TEST', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('TEST')

    assert.equal(quote.marketCap, 150.3e9)
  })

  test('market cap parsing handles M suffix', async ({ assert }) => {
    const html = QUOTE_PAGE_HTML.replace('2.95T', '850M')
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('TEST', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('TEST')

    assert.equal(quote.marketCap, 850e6)
  })

  test('market cap parsing handles K suffix', async ({ assert }) => {
    const html = QUOTE_PAGE_HTML.replace('2.95T', '500K')
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('TEST', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('TEST')

    assert.equal(quote.marketCap, 500e3)
  })

  test('price parsing strips currency symbols and commas', async ({ assert }) => {
    const html = QUOTE_PAGE_HTML
      .replace('data-last-price="189.84"', 'data-last-price="1234.56"')
      .replace('142.00 - 199.62', '$1,100.00 - $1,500.00')
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('TEST', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('TEST')

    assert.equal(quote.regularMarketPrice, 1234.56)
    assert.equal(quote.fiftyTwoWeekLow, 1100.00)
    assert.equal(quote.fiftyTwoWeekHigh, 1500.00)
  })

  // --- fetchQuote edge cases ---

  test('fetchQuote tries multiple exchanges and uses the one that works', async ({ assert }) => {
    const triedUrls: string[] = []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      triedUrls.push(url)
      // Only NYSE has price data
      if (url.includes(':NYSE')) return QUOTE_PAGE_HTML
      return QUOTE_PAGE_NO_PRICE_HTML
    }

    const quote = await GoogleFinanceService.fetchQuote('TEST')

    assert.isNotNull(quote)
    assert.equal(quote.exchange, 'NYSE')
    // Should have tried NASDAQ first (no data), then NYSE (found data)
    assert.isTrue(triedUrls.some((u) => u.includes(':NASDAQ')))
    assert.isTrue(triedUrls.some((u) => u.includes(':NYSE')))
  })

  test('fetchQuote returns nulls for optional fields when no stats present', async ({ assert }) => {
    const html = `
    <html>
    <head><title>Minimal Stock Price - Google Finance</title></head>
    <body><div data-last-price="50.00">$50.00</div></body>
    </html>`
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('MIN', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('MIN')

    assert.isNotNull(quote)
    assert.equal(quote.regularMarketPrice, 50.00)
    assert.isNull(quote.marketCap)
    assert.isNull(quote.fiftyTwoWeekHigh)
    assert.isNull(quote.fiftyTwoWeekLow)
    assert.isNull(quote.trailingPE)
    assert.isNull(quote.dividendYield)
    assert.isNull(quote.averageDailyVolume3Month)
  })

  test('fetchQuote EPS is null when P/E is null', async ({ assert }) => {
    const html = `
    <html>
    <head><title>NoPE Stock Price - Google Finance</title></head>
    <body><div data-last-price="100.00">$100.00</div></body>
    </html>`
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('NOPE', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('NOPE')

    assert.isNull(quote.epsTrailingTwelveMonths)
  })

  test('fetchQuote shortName defaults to uppercased symbol when no title/heading match', async ({ assert }) => {
    const html = `
    <html>
    <head><title>Google Finance</title></head>
    <body><div data-last-price="10.00">$10.00</div></body>
    </html>`
    GoogleFinanceService['fetchHTML'] = async () => html
    GoogleFinanceService['exchangeCache'].set('XYZ', 'NYSE')

    const quote = await GoogleFinanceService.fetchQuote('xyz')

    assert.equal(quote.shortName, 'XYZ')
  })

  // --- exchange resolution edge cases ---

  test('fetchQuote uses knownExchange first when provided', async ({ assert }) => {
    const triedUrls: string[] = []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      triedUrls.push(url)
      return QUOTE_PAGE_HTML
    }

    const quote = await GoogleFinanceService.fetchQuote('TEST', 'LON')

    assert.isNotNull(quote)
    assert.equal(quote.exchange, 'LON')
    // Should have tried LON first and found data immediately
    assert.equal(triedUrls.length, 1)
    assert.isTrue(triedUrls[0].includes(':LON'))
  })

  test('fetchQuote falls through all exchanges when none have data', async ({ assert }) => {
    const triedUrls: string[] = []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      triedUrls.push(url)
      return QUOTE_PAGE_NO_PRICE_HTML
    }

    const quote = await GoogleFinanceService.fetchQuote('XYZXYZ')

    assert.isNull(quote)
    // Should have tried all 4 common exchanges
    assert.isTrue(triedUrls.length >= 4)
  })

  test('fetchQuote uses cached exchange from previous call', async ({ assert }) => {
    // Pre-populate cache
    GoogleFinanceService['exchangeCache'].set('CACHED', 'NYSEARCA')
    GoogleFinanceService['fetchHTML'] = async () => QUOTE_PAGE_HTML

    const quote = await GoogleFinanceService.fetchQuote('CACHED')

    assert.isNotNull(quote)
    assert.equal(quote.exchange, 'NYSEARCA')
  })

  test('fetchQuote skips exchanges that throw errors', async ({ assert }) => {
    let callCount = 0
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      callCount++
      if (url.includes(':NASDAQ')) throw new Error('timeout')
      return QUOTE_PAGE_HTML // NYSE works
    }

    const quote = await GoogleFinanceService.fetchQuote('TEST')

    assert.isNotNull(quote)
    assert.equal(quote.exchange, 'NYSE')
    assert.isTrue(callCount >= 2)
  })

  // --- searchTicker edge cases ---

  test('searchTicker extracts name that is not the symbol or exchange', async ({ assert }) => {
    const searchHtml = `<html><body>
      <a href="/finance/quote/GOOG:NASDAQ">GOOG\nAlphabet Inc Class C\nNASDAQ</a>
    </body></html>`
    GoogleFinanceService['fetchHTML'] = async () => searchHtml

    const results = await GoogleFinanceService.searchTicker('GOOG')

    assert.equal(results[0].name, 'Alphabet Inc Class C')
  })

  test('searchTicker skips links without exchange in href', async ({ assert }) => {
    const searchHtml = `<html><body>
      <a href="/finance/quote/AAPL">AAPL\nApple Inc</a>
      <a href="/finance/quote/MSFT:NASDAQ">MSFT\nMicrosoft\nNASDAQ</a>
    </body></html>`
    GoogleFinanceService['fetchHTML'] = async () => searchHtml

    const results = await GoogleFinanceService.searchTicker('test')

    assert.lengthOf(results, 1)
    assert.equal(results[0].symbol, 'MSFT')
  })

  test('searchTicker callback fallback deduplicates entries', async ({ assert }) => {
    const html = `<html><body>
    <script>
    AF_initDataCallback({key: 'ds:1', data: [["AAPL","Apple Inc","NASDAQ"],["AAPL","Apple Inc","NASDAQ"]]});
    </script>
    </body></html>`
    GoogleFinanceService['fetchHTML'] = async () => html

    const results = await GoogleFinanceService.searchTicker('AAPL')

    const aaplResults = results.filter((r: any) => r.symbol === 'AAPL')
    assert.equal(aaplResults.length, 1)
  })

  // --- fetchHistorical edge cases ---

  test('fetchHistorical handles millisecond timestamps', async ({ assert }) => {
    // Timestamp > 1e12 means it's already in milliseconds
    const html = `<html><body>
    <script>
    AF_initDataCallback({key: 'ds:5', data: [[1704067200000,185.50,186.70,184.30,186.00,45000000]]});
    </script>
    </body></html>`
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return html
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isTrue(bars.length > 0)
    // Should be Jan 1, 2024 (same as 1704067200 seconds)
    assert.equal(bars[0].date.getFullYear(), 2024)
  })

  test('fetchHistorical handles bars without volume (5 elements)', async ({ assert }) => {
    const html = `<html><body>
    <script>
    AF_initDataCallback({key: 'ds:5', data: [[1704067200,185.50,186.70,184.30,186.00]]});
    </script>
    </body></html>`
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return html
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isTrue(bars.length > 0)
    assert.equal(bars[0].volume, 0)
  })

  test('fetchHistorical AF_initDataCallback with single bar works', async ({ assert }) => {
    const html = `<html><body>
    <script>
    AF_initDataCallback({key: 'ds:5', data: [[1704067200,190.00,192.50,189.00,191.80,60000000]]});
    </script>
    </body></html>`
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return html
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.equal(bars.length, 1)
    assert.closeTo(bars[0].open, 190.0, 0.01)
  })

  test('fetchHistorical parses date correctly from second timestamp', async ({ assert }) => {
    const html = `<html><body>
    <script>
    AF_initDataCallback({key: 'ds:5', data: [[1704067200,185.50,186.70,184.30,186.00,45000000]]});
    </script>
    </body></html>`
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return html
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.equal(bars.length, 1)
    assert.equal(bars[0].date.getFullYear(), 2024)
  })

  test('fetchHistorical skips bars before period1 date', async ({ assert }) => {
    // Two bars: one from 2024-01-01, one from 2024-01-02
    // With period1=2024-01-02, only the second should be returned
    const html = `<html><body>
    <script>
    AF_initDataCallback({key: 'ds:5', data: [[1704067200,185.50,186.70,184.30,186.00,45000000],[1704153600,186.20,188.00,185.80,187.50,52000000]]});
    </script>
    </body></html>`
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return html
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2024-01-02')

    assert.equal(bars.length, 1)
    assert.closeTo(bars[0].open, 186.2, 0.01)
  })

  test('fetchHistorical ignores invalid JSON in window data', async ({ assert }) => {
    const html = `<html><body>
    <script>
    window.chartData = {not valid json!!!};
    </script>
    </body></html>`
    GoogleFinanceService['fetchHistoricalFromStooq'] = async () => []
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_PAGE_HTML
      return html
    }

    const bars = await GoogleFinanceService.fetchHistorical('AAPL', '2020-01-01')

    assert.isArray(bars)
    assert.lengthOf(bars, 0)
  })

  // --- parsePrice / parseMarketCap edge cases ---

  test('parsePrice returns null for empty string', async ({ assert }) => {
    const result = GoogleFinanceService['parsePrice']('')
    assert.isNull(result)
  })

  test('parsePrice returns null for non-numeric garbage', async ({ assert }) => {
    const result = GoogleFinanceService['parsePrice']('N/A')
    assert.isNull(result)
  })

  test('parsePrice handles negative numbers', async ({ assert }) => {
    const result = GoogleFinanceService['parsePrice']('-$5.23')
    assert.equal(result, -5.23)
  })

  test('parseMarketCap returns null for empty string', async ({ assert }) => {
    const result = GoogleFinanceService['parseMarketCap']('')
    assert.isNull(result)
  })

  test('parseMarketCap returns null for non-numeric text', async ({ assert }) => {
    const result = GoogleFinanceService['parseMarketCap']('N/A')
    assert.isNull(result)
  })

  test('parseMarketCap returns raw number when no suffix', async ({ assert }) => {
    const result = GoogleFinanceService['parseMarketCap']('12345')
    assert.equal(result, 12345)
  })

  test('parseMarketCap handles T followed by currency code', async ({ assert }) => {
    const result = GoogleFinanceService['parseMarketCap']('3.69T USD')
    assert.equal(result, 3.69e12)
  })

  test('parseMarketCap handles B followed by currency code', async ({ assert }) => {
    const result = GoogleFinanceService['parseMarketCap']('150.3B USD')
    assert.equal(result, 150.3e9)
  })

  test('parseMarketCap handles TRILLION word', async ({ assert }) => {
    const result = GoogleFinanceService['parseMarketCap']('2.5 TRILLION')
    assert.equal(result, 2.5e12)
  })

  // --- syncTicker error path ---

  test('syncTicker throws when fetchQuote returns null', async ({ assert }) => {
    GoogleFinanceService['fetchHTML'] = async (url: string) => {
      if (url.includes('?q=')) return SEARCH_EMPTY_HTML
      return QUOTE_PAGE_NO_PRICE_HTML
    }

    await assert.rejects(
      () => GoogleFinanceService.syncTicker('FAKE'),
      'Could not fetch data for FAKE'
    )
  })

  // --- FinanceService facade tests ---

  test('FinanceService facade exports service with expected interface', async ({ assert }) => {
    const FinanceService = (await import('../../app/Services/FinanceService')).default

    assert.isFunction(FinanceService.fetchQuote)
    assert.isFunction(FinanceService.fetchHistorical)
    assert.isFunction(FinanceService.searchTicker)
    assert.isFunction(FinanceService.syncTicker)
    assert.isFunction(FinanceService.syncTickersBulk)
    assert.isFunction(FinanceService.syncHistoricalSnapshots)
    assert.isFunction(FinanceService.getTickerSummary)
  })
})
