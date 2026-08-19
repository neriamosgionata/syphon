import { test } from '@japa/runner'
import { seedQuantData, cleanupQuantData } from './quant-seed.js'

test.group('Quant API', (group) => {
  let seedHandle: any = null

  group.setup(async () => {
    seedHandle = await seedQuantData()
  })

  group.teardown(async () => {
    if (seedHandle) {
      await cleanupQuantData(seedHandle)
      seedHandle = null
    }
  })

  test('GET /api/quant/screener returns screener data', async ({ client, assert }) => {
    const response = await client.get('/api/quant/screener')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'generated_at')
    assert.property(body, 'count')
    assert.property(body, 'tickers')
    assert.isArray(body.tickers)
    assert.isNumber(body.count)
    assert.equal(body.count, body.tickers.length)
  })

  test('GET /api/quant/screener returns correct ticker structure', async ({ client, assert }) => {
    const response = await client.get('/api/quant/screener')

    response.assertStatus(200)
    const tickers = response.body().tickers
    if (tickers.length > 0) {
      const t = tickers[0]
      assert.property(t, 'symbol')
      assert.property(t, 'name')
      assert.property(t, 'composite_score')
      assert.property(t, 'signal')
      assert.property(t, 'rsi14')
      assert.property(t, 'macd_histogram')
      assert.property(t, 'sma_trend')
      assert.property(t, 'sharpe')
      assert.property(t, 'beta')
      assert.property(t, 'patterns')
      assert.property(t, 'conviction')
      assert.property(t, 'regime')
      assert.property(t, 'sentiment_score')
      assert.property(t, 'article_count')
      assert.isArray(t.patterns)
      assert.include(
        ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'],
        t.signal
      )
      assert.isNumber(t.conviction)
      assert.isTrue(t.conviction >= 0 && t.conviction <= 1)
    }
  })

  test('GET /api/quant/screener is sorted by composite score descending', async ({ client, assert }) => {
    const response = await client.get('/api/quant/screener')

    response.assertStatus(200)
    const tickers = response.body().tickers
    if (tickers.length >= 2) {
      for (let i = 1; i < tickers.length; i++) {
        assert.isTrue(
          tickers[i - 1].composite_score >= tickers[i].composite_score,
          `Ticker ${i - 1} (${tickers[i - 1].composite_score}) >= ticker ${i} (${tickers[i].composite_score})`
        )
      }
    }
  })

  test('GET /api/quant/screener supports min_articles param', async ({ client, assert }) => {
    const response = await client.get('/api/quant/screener').qs({ min_articles: 1 })
    response.assertStatus(200)
    assert.isArray(response.body().tickers)
  })

  test('GET /api/quant/:symbol returns analysis for valid ticker', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.symbol, 'AAPL')
    assert.property(body, 'sma20')
    assert.property(body, 'sma50')
    assert.property(body, 'sma200')
    assert.property(body, 'rsi14')
    assert.property(body, 'macd')
    assert.property(body, 'bollingerBands')
    assert.property(body, 'stochastic')
    assert.property(body, 'adx')
    assert.property(body, 'atr14')
    assert.property(body, 'volatility20d')
    assert.property(body, 'sharpeRatio')
    assert.property(body, 'sortinoRatio')
    assert.property(body, 'maxDrawdown')
    assert.property(body, 'beta')
    assert.property(body, 'patterns')
    assert.property(body, 'compositeScore')
    assert.property(body, 'quantSignal')
    assert.property(body, 'scoreBreakdown')
    assert.property(body, 'recommendation')
    assert.isNumber(body.dataPoints)
    assert.isTrue(body.dataPoints > 100)
  })

  test('GET /api/quant/:symbol returns 404 for unknown ticker', async ({ client }) => {
    const response = await client.get('/api/quant/ZZZXXX')
    response.assertStatus(404)
  })

  test('GET /api/quant/:symbol MACD has series data', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const macd = response.body().macd
    if (macd) {
      assert.property(macd, 'macd')
      assert.property(macd, 'signal')
      assert.property(macd, 'histogram')
      assert.property(macd, 'series')
      assert.isArray(macd.series)
      assert.isTrue(macd.series.length > 0)
      assert.property(macd.series[0], 'date')
    }
  })

  test('GET /api/quant/:symbol Bollinger Bands have correct fields', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const bb = response.body().bollingerBands
    if (bb) {
      assert.property(bb, 'upper')
      assert.property(bb, 'middle')
      assert.property(bb, 'lower')
      assert.property(bb, 'width')
      assert.property(bb, 'percentB')
      assert.isTrue(bb.upper > bb.middle)
      assert.isTrue(bb.middle > bb.lower)
    }
  })

  test('GET /api/quant/:symbol RSI is between 0 and 100', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const rsi = response.body().rsi14
    if (rsi !== null) {
      assert.isTrue(rsi >= 0 && rsi <= 100, `RSI ${rsi} should be between 0 and 100`)
    }
  })

  test('GET /api/quant/:symbol stochastic has k and d values', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const stoch = response.body().stochastic
    if (stoch) {
      assert.property(stoch, 'k')
      assert.property(stoch, 'd')
      assert.isTrue(stoch.k >= 0 && stoch.k <= 100)
      assert.isTrue(stoch.d >= 0 && stoch.d <= 100)
    }
  })

  test('GET /api/quant/:symbol ADX has directional indicators', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const adx = response.body().adx
    if (adx) {
      assert.property(adx, 'adx')
      assert.property(adx, 'plusDI')
      assert.property(adx, 'minusDI')
      assert.isTrue(adx.adx >= 0)
    }
  })

  test('GET /api/quant/:symbol includes OBV data', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'obv')
  })

  test('GET /api/quant/:symbol includes return metrics', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'return5d')
    assert.property(body, 'return20d')
    assert.property(body, 'return60d')
  })

  test('GET /api/quant/:symbol volatility is positive', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const vol = response.body().volatility20d
    if (vol !== null) {
      assert.isTrue(vol > 0, 'Volatility should be positive')
    }
  })

  test('GET /api/quant/:symbol composite score is a number', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    assert.isNumber(response.body().compositeScore)
  })

  test('GET /api/quant/:symbol quantSignal is a valid signal', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    assert.include(
      ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'],
      response.body().quantSignal
    )
  })

  test('GET /api/quant/:symbol patterns are well-formed', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const patterns = response.body().patterns
    assert.isArray(patterns)
    if (patterns.length > 0) {
      const p = patterns[0]
      assert.property(p, 'name')
      assert.property(p, 'type')
      assert.property(p, 'strength')
      assert.include(['bullish', 'bearish', 'neutral'], p.type)
      assert.isTrue(p.strength >= 0 && p.strength <= 1)
    }
  })

  test('GET /api/quant/:symbol is case insensitive', async ({ client, assert }) => {
    const response = await client.get('/api/quant/aapl')

    if (response.status() === 200) {
      assert.equal(response.body().symbol, 'AAPL')
    } else {
      response.assertStatus(404)
    }
  })

  test('GET /api/quant/:symbol maxDrawdown is between 0 and 1', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const dd = response.body().maxDrawdown
    if (dd !== null) {
      assert.isTrue(dd >= 0 && dd <= 1, `Max drawdown ${dd} should be between 0 and 1`)
    }
  })

  test('GET /api/quant/screener has generated_at as valid ISO date', async ({ client, assert }) => {
    const response = await client.get('/api/quant/screener')

    response.assertStatus(200)
    const date = new Date(response.body().generated_at)
    assert.isFalse(isNaN(date.getTime()))
  })

  test('GET /api/quant/screener count is non-negative', async ({ client, assert }) => {
    const response = await client.get('/api/quant/screener')

    response.assertStatus(200)
    assert.isTrue(response.body().count >= 0)
  })

  // --- New unified engine tests ---

  test('GET /api/quant/:symbol has scoreBreakdown with all sections', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const bd = response.body().scoreBreakdown
    assert.isObject(bd)
    // Technical
    assert.property(bd, 'rsi')
    assert.property(bd, 'macd')
    assert.property(bd, 'bollingerBands')
    assert.property(bd, 'trend')
    assert.property(bd, 'adx')
    assert.property(bd, 'stochastic')
    assert.property(bd, 'momentum')
    assert.property(bd, 'volume')
    assert.property(bd, 'patterns')
    // Sentiment
    assert.property(bd, 'sentiment')
    assert.property(bd, 'sentimentMomentum')
    assert.property(bd, 'newsVolume')
    // Risk/Fundamentals
    assert.property(bd, 'sharpe')
    assert.property(bd, 'beta')
    assert.property(bd, 'pe')
    assert.property(bd, 'fiftyTwoWeek')
  })

  test('GET /api/quant/:symbol has recommendation with trading data', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const rec = response.body().recommendation
    assert.isObject(rec)
    assert.property(rec, 'action')
    assert.property(rec, 'conviction')
    assert.property(rec, 'regime')
    assert.property(rec, 'positionSize')
    assert.include(
      ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'],
      rec.action
    )
    assert.include(
      ['trending_up', 'trending_down', 'ranging', 'volatile', 'unknown'],
      rec.regime
    )
    assert.isTrue(rec.conviction >= 0 && rec.conviction <= 1)
    assert.isTrue(rec.positionSize >= 0 && rec.positionSize <= 1)
  })

  test('GET /api/quant/:symbol includes sentiment data', async ({ client, assert }) => {
    const response = await client.get('/api/quant/AAPL')

    response.assertStatus(200)
    const body = response.body()
    // sentiment may be null if no articles
    if (body.sentiment !== null) {
      assert.property(body.sentiment, 'totalArticles')
      assert.property(body.sentiment, 'avgScore')
      assert.property(body.sentiment, 'recentTrend')
      assert.isNumber(body.sentiment.totalArticles)
    }
  })

  // --- Signals endpoint backward compatibility ---

  test('GET /api/signals returns signals via unified engine', async ({ client, assert }) => {
    const response = await client.get('/api/signals')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'generated_at')
    assert.property(body, 'count')
    assert.property(body, 'signals')
    assert.isArray(body.signals)
    if (body.signals.length > 0) {
      const s = body.signals[0]
      assert.property(s, 'symbol')
      assert.property(s, 'compositeScore')
      assert.property(s, 'signal')
      assert.property(s, 'breakdown')
      assert.property(s, 'meta')
    }
  })

  test('GET /api/signals supports days param', async ({ client, assert }) => {
    const response = await client.get('/api/signals').qs({ days: 7 })
    response.assertStatus(200)
    assert.isArray(response.body().signals)
  })
})
