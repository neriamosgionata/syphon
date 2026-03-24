import { test } from '@japa/runner'

test.group('Quant API', () => {
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
      assert.isArray(t.patterns)
      assert.include(
        ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'],
        t.signal
      )
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
})
