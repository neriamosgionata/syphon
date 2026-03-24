import { test } from '@japa/runner'

let TradingSignalService: any

test.group('TradingSignalService', (group) => {
  group.setup(async () => {
    const { join } = await import('path')
    const { Application } = await import('@adonisjs/application')
    const app = new Application(join(__dirname, '../..'), 'test', {
      aliases: { App: 'app' },
    })

    app.container.singleton('Adonis/Core/Logger', () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }))

    app.container.singleton('Adonis/Lucid/Database', () => ({
      rawQuery: async () => [[]],
    }))

    // Register Ticker model stub so IoC resolves App/Models/Ticker
    const TickerStub = class Ticker {
      static query() {
        return {
          where: () => TickerStub.query(),
          preload: () => TickerStub.query(),
          first: async () => null,
          exec: async () => [],
        }
      }
    }
    app.container.bind('App/Models/Ticker', () => TickerStub)

    global[Symbol.for('ioc.use')] = app.container.use.bind(app.container)
    global[Symbol.for('ioc.make')] = app.container.make.bind(app.container)
    global[Symbol.for('ioc.call')] = app.container.call.bind(app.container)

    TradingSignalService = (await import('../../app/Services/TradingSignalService')).default
  })

  // --- Signal Classification ---

  test('classifySignal returns strong_buy for score >= 40', ({ assert }) => {
    assert.equal(TradingSignalService['classifySignal'](40), 'strong_buy')
    assert.equal(TradingSignalService['classifySignal'](80), 'strong_buy')
  })

  test('classifySignal returns buy for score 15-39', ({ assert }) => {
    assert.equal(TradingSignalService['classifySignal'](15), 'buy')
    assert.equal(TradingSignalService['classifySignal'](39), 'buy')
  })

  test('classifySignal returns neutral for score -14 to 14', ({ assert }) => {
    assert.equal(TradingSignalService['classifySignal'](0), 'neutral')
    assert.equal(TradingSignalService['classifySignal'](14), 'neutral')
    assert.equal(TradingSignalService['classifySignal'](-14), 'neutral')
  })

  test('classifySignal returns sell for score -15 to -39', ({ assert }) => {
    assert.equal(TradingSignalService['classifySignal'](-15), 'sell')
    assert.equal(TradingSignalService['classifySignal'](-39), 'sell')
  })

  test('classifySignal returns strong_sell for score <= -40', ({ assert }) => {
    assert.equal(TradingSignalService['classifySignal'](-40), 'strong_sell')
    assert.equal(TradingSignalService['classifySignal'](-80), 'strong_sell')
  })

  // --- Sentiment Scoring ---

  test('scoreSentiment maps avgScore to [-100, 100]', ({ assert }) => {
    assert.equal(TradingSignalService['scoreSentiment']({ avgScore: 1 }), 100)
    assert.equal(TradingSignalService['scoreSentiment']({ avgScore: -1 }), -100)
    assert.equal(TradingSignalService['scoreSentiment']({ avgScore: 0 }), 0)
    assert.equal(TradingSignalService['scoreSentiment']({ avgScore: 0.5 }), 50)
  })

  test('scoreSentimentMomentum caps at ±100', ({ assert }) => {
    assert.equal(TradingSignalService['scoreSentimentMomentum']({ recentTrend: 1 }), 100)
    assert.equal(TradingSignalService['scoreSentimentMomentum']({ recentTrend: -1 }), -100)
    assert.equal(TradingSignalService['scoreSentimentMomentum']({ recentTrend: 0.25 }), 50)
  })

  test('scoreNewsVolume returns 0 for no articles', ({ assert }) => {
    assert.equal(TradingSignalService['scoreNewsVolume']({ totalArticles: 0 }), 0)
  })

  test('scoreNewsVolume scales logarithmically', ({ assert }) => {
    const score1 = TradingSignalService['scoreNewsVolume']({ totalArticles: 1 })
    const score5 = TradingSignalService['scoreNewsVolume']({ totalArticles: 5 })
    const score20 = TradingSignalService['scoreNewsVolume']({ totalArticles: 20 })

    assert.isTrue(score1 > 0)
    assert.isTrue(score5 > score1)
    assert.isTrue(score20 > score5)
    assert.isTrue(score20 <= 100)
  })

  // --- Technical Scoring ---

  test('scorePriceMomentum returns 0 with insufficient data', ({ assert }) => {
    assert.equal(TradingSignalService['scorePriceMomentum']([]), 0)
    assert.equal(TradingSignalService['scorePriceMomentum']([{ close: 100 }]), 0)
  })

  test('scorePriceMomentum positive for upward price', ({ assert }) => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({ close: 100 + i * 5 }))
    const score = TradingSignalService['scorePriceMomentum'](snapshots)
    assert.isTrue(score > 0)
  })

  test('scorePriceMomentum negative for downward price', ({ assert }) => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({ close: 200 - i * 5 }))
    const score = TradingSignalService['scorePriceMomentum'](snapshots)
    assert.isTrue(score < 0)
  })

  test('scorePriceMomentum caps at ±100', ({ assert }) => {
    const huge = Array.from({ length: 10 }, (_, i) => ({ close: i < 5 ? 10 : 500 }))
    const score = TradingSignalService['scorePriceMomentum'](huge)
    assert.isTrue(score <= 100)
    assert.isTrue(score >= -100)
  })

  test('calculateRSI returns null with insufficient data', ({ assert }) => {
    const snapshots = Array.from({ length: 5 }, (_, i) => ({ close: 100 + i }))
    assert.isNull(TradingSignalService['calculateRSI'](snapshots))
  })

  test('calculateRSI returns value between 0 and 100', ({ assert }) => {
    const snapshots = Array.from({ length: 30 }, (_, i) => ({
      close: 100 + Math.sin(i / 3) * 10,
    }))
    const rsi = TradingSignalService['calculateRSI'](snapshots)
    assert.isNotNull(rsi)
    assert.isTrue(rsi! >= 0 && rsi! <= 100)
  })

  test('calculateRSI returns 100 for only gains', ({ assert }) => {
    const snapshots = Array.from({ length: 20 }, (_, i) => ({ close: 100 + i * 2 }))
    const rsi = TradingSignalService['calculateRSI'](snapshots)
    assert.equal(rsi, 100)
  })

  test('scoreRSI positive for oversold', ({ assert }) => {
    // Mock a scenario: RSI < 30 should score positive
    const snapshots = Array.from({ length: 20 }, (_, i) => ({ close: 200 - i * 5 }))
    const rsi = TradingSignalService['calculateRSI'](snapshots)
    if (rsi !== null && rsi < 30) {
      const score = TradingSignalService['scoreRSI'](snapshots)
      assert.isTrue(score > 0)
    }
  })

  test('scoreVolatility returns 0 with insufficient data', ({ assert }) => {
    assert.equal(TradingSignalService['scoreVolatility']([{ close: 100 }]), 0)
  })

  test('calculateVolatility returns null with insufficient data', ({ assert }) => {
    assert.isNull(TradingSignalService['calculateVolatility']([]))
  })

  test('calculateVolatility returns positive number for valid data', ({ assert }) => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      close: 100 + (i % 2 === 0 ? 5 : -3),
    }))
    const vol = TradingSignalService['calculateVolatility'](snapshots)
    assert.isNotNull(vol)
    assert.isTrue(vol! > 0)
  })

  test('scoreVolumeTrend returns 0 with insufficient data', ({ assert }) => {
    assert.equal(TradingSignalService['scoreVolumeTrend']([]), 0)
    const few = Array.from({ length: 5 }, () => ({ volume: 1000 }))
    assert.equal(TradingSignalService['scoreVolumeTrend'](few), 0)
  })

  test('scoreVolumeTrend positive for increasing volume', ({ assert }) => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      volume: i < 5 ? 1000 : 2000,
    }))
    const score = TradingSignalService['scoreVolumeTrend'](snapshots)
    assert.isTrue(score > 0)
  })

  test('scoreVolumeTrend negative for decreasing volume', ({ assert }) => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      volume: i < 5 ? 2000 : 1000,
    }))
    const score = TradingSignalService['scoreVolumeTrend'](snapshots)
    assert.isTrue(score < 0)
  })

  // --- Fundamentals ---

  test('score52WeekPosition returns 0 without metadata', ({ assert }) => {
    const ticker = { currentPrice: 100, metadata: {} }
    assert.equal(TradingSignalService['score52WeekPosition'](ticker), 0)
  })

  test('score52WeekPosition positive near 52-week low', ({ assert }) => {
    const ticker = {
      currentPrice: 55,
      metadata: { fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 50 },
    }
    const score = TradingSignalService['score52WeekPosition'](ticker)
    assert.isTrue(score > 0)
  })

  test('score52WeekPosition negative near 52-week high', ({ assert }) => {
    const ticker = {
      currentPrice: 195,
      metadata: { fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 50 },
    }
    const score = TradingSignalService['score52WeekPosition'](ticker)
    assert.isTrue(score < 0)
  })

  test('scoreFundamentals returns 0 without P/E', ({ assert }) => {
    assert.equal(TradingSignalService['scoreFundamentals']({ metadata: {} }), 0)
  })

  test('scoreFundamentals positive for low P/E', ({ assert }) => {
    const score = TradingSignalService['scoreFundamentals']({ metadata: { pe: 12 } })
    assert.isTrue(score > 0)
  })

  test('scoreFundamentals negative for high P/E', ({ assert }) => {
    const score = TradingSignalService['scoreFundamentals']({ metadata: { pe: 60 } })
    assert.isTrue(score < 0)
  })

  test('scoreFundamentals negative for negative earnings', ({ assert }) => {
    const score = TradingSignalService['scoreFundamentals']({ metadata: { pe: -5 } })
    assert.isTrue(score < 0)
  })

  // --- Price Changes ---

  test('calculatePriceChanges returns nulls with insufficient data', ({ assert }) => {
    const result = TradingSignalService['calculatePriceChanges']([])
    assert.isNull(result.change7d)
    assert.isNull(result.change30d)
  })

  test('calculatePriceChanges computes 7d change', ({ assert }) => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({ close: 100 + i * 2 }))
    const result = TradingSignalService['calculatePriceChanges'](snapshots)
    assert.isNotNull(result.change7d)
    assert.isTrue(result.change7d! > 0)
  })
})
