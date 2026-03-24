import { test } from '@japa/runner'

test.group('Signals API', () => {
  test('GET /api/signals returns signal data', async ({ client, assert }) => {
    const response = await client.get('/api/signals')

    response.assertStatus(200)
    const body = response.body()
    assert.property(body, 'generated_at')
    assert.property(body, 'count')
    assert.property(body, 'signals')
    assert.isString(body.generated_at)
    assert.isNumber(body.count)
    assert.isArray(body.signals)
  })

  test('GET /api/signals returns correct signal structure', async ({ client, assert }) => {
    const response = await client.get('/api/signals')

    response.assertStatus(200)
    const body = response.body()

    if (body.signals.length > 0) {
      const signal = body.signals[0]
      assert.property(signal, 'symbol')
      assert.property(signal, 'name')
      assert.property(signal, 'compositeScore')
      assert.property(signal, 'signal')
      assert.property(signal, 'breakdown')
      assert.property(signal, 'meta')

      assert.isString(signal.symbol)
      assert.isNumber(signal.compositeScore)
      assert.include(
        ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'],
        signal.signal
      )

      // Breakdown fields
      assert.properties(signal.breakdown, [
        'sentiment',
        'sentimentMomentum',
        'newsVolume',
        'priceMomentum',
        'rsi',
        'volatility',
        'volumeTrend',
        'fiftyTwoWeekPosition',
        'fundamentals',
      ])

      // Meta fields
      assert.properties(signal.meta, [
        'articleCount',
        'avgSentiment',
        'recentSentimentTrend',
        'priceChange7d',
        'priceChange30d',
        'rsiValue',
        'volatility30d',
        'pe',
        'snapshotDays',
      ])
    }
  })

  test('GET /api/signals supports days param', async ({ client, assert }) => {
    const response = await client.get('/api/signals').qs({ days: 7 })

    response.assertStatus(200)
    assert.isArray(response.body().signals)
  })

  test('GET /api/signals supports min_articles param', async ({ client, assert }) => {
    const all = await client.get('/api/signals').qs({ min_articles: 0 })
    const filtered = await client.get('/api/signals').qs({ min_articles: 100 })

    all.assertStatus(200)
    filtered.assertStatus(200)
    assert.isTrue(all.body().count >= filtered.body().count)
  })

  test('GET /api/signals returns signals sorted by composite score descending', async ({ client, assert }) => {
    const response = await client.get('/api/signals')

    response.assertStatus(200)
    const signals = response.body().signals
    if (signals.length >= 2) {
      for (let i = 1; i < signals.length; i++) {
        assert.isTrue(
          signals[i - 1].compositeScore >= signals[i].compositeScore,
          `Signal ${i - 1} (${signals[i - 1].compositeScore}) should be >= signal ${i} (${signals[i].compositeScore})`
        )
      }
    }
  })

  test('GET /api/signals count matches signals array length', async ({ client, assert }) => {
    const response = await client.get('/api/signals')

    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.count, body.signals.length)
  })
})
