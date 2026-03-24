import { test } from '@japa/runner'

let QE: any

test.group('QuantEngine internals', (group) => {
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

    const ModelStub = class {
      static query() {
        return { where: () => ModelStub.query(), orderBy: () => ModelStub.query(), first: async () => null }
      }
      static findBy() { return null }
    }
    app.container.bind('App/Models/Ticker', () => ModelStub)
    app.container.bind('App/Models/TickerSnapshot', () => ModelStub)

    global[Symbol.for('ioc.use')] = app.container.use.bind(app.container)
    global[Symbol.for('ioc.make')] = app.container.make.bind(app.container)
    global[Symbol.for('ioc.call')] = app.container.call.bind(app.container)

    const mod = await import('../../app/Services/QuantEngine')
    QE = mod._internals
  })

  // --- Basic math ---

  test('mean computes average', ({ assert }) => {
    assert.equal(QE.mean([1, 2, 3, 4, 5]), 3)
    assert.equal(QE.mean([10]), 10)
  })

  test('stddev computes standard deviation', ({ assert }) => {
    const sd = QE.stddev([2, 4, 4, 4, 5, 5, 7, 9])
    assert.isTrue(sd > 1.9 && sd < 2.1)
  })

  // --- SMA ---

  test('sma returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.sma([1, 2, 3], 5))
  })

  test('sma computes simple moving average', ({ assert }) => {
    assert.equal(QE.sma([1, 2, 3, 4, 5], 3), 4) // (3+4+5)/3
    assert.equal(QE.sma([10, 20, 30, 40, 50], 5), 30)
  })

  test('smaSeries computes rolling SMA', ({ assert }) => {
    const series = QE.smaSeries([1, 2, 3, 4, 5, 6], 3)
    assert.equal(series.length, 4)
    assert.equal(series[0], 2)   // (1+2+3)/3
    assert.equal(series[3], 5)   // (4+5+6)/3
  })

  // --- EMA ---

  test('ema returns empty array with insufficient data', ({ assert }) => {
    assert.deepEqual(QE.ema([1, 2], 5), [])
  })

  test('ema first value is SMA of initial period', ({ assert }) => {
    const result = QE.ema([2, 4, 6, 8, 10], 3)
    assert.equal(result[0], 4) // SMA of [2,4,6] = 4
    assert.isTrue(result.length === 3)
  })

  test('ema responds more to recent prices', ({ assert }) => {
    const data = [10, 10, 10, 10, 10, 20, 20, 20]
    const result = QE.ema(data, 3)
    // EMA should track toward 20 but lag behind SMA which is already at 20
    const emaVal = result[result.length - 1]
    assert.isTrue(emaVal > 15) // should have moved significantly toward 20
    assert.isTrue(emaVal < 20) // but still lags behind
  })

  // --- RSI ---

  test('computeRSI returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.computeRSI([1, 2, 3], 14))
  })

  test('computeRSI returns 100 for only gains', ({ assert }) => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    assert.equal(QE.computeRSI(closes, 14), 100)
  })

  test('computeRSI returns value between 0 and 100', ({ assert }) => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 10)
    const rsi = QE.computeRSI(closes, 14)
    assert.isNotNull(rsi)
    assert.isTrue(rsi! >= 0 && rsi! <= 100)
  })

  test('computeRSI is low for sustained decline', ({ assert }) => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 3)
    const rsi = QE.computeRSI(closes, 14)
    assert.isNotNull(rsi)
    assert.isTrue(rsi! < 20)
  })

  // --- MACD ---

  test('computeMACD returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.computeMACD(Array(30).fill(100), 12, 26, 9))
  })

  test('computeMACD returns valid structure', ({ assert }) => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 20)
    const macd = QE.computeMACD(closes, 12, 26, 9)
    assert.isNotNull(macd)
    assert.properties(macd, ['macd', 'signal', 'histogram', 'series'])
    assert.isTrue(macd.series.length > 0)
    assert.equal(macd.histogram, macd.macd - macd.signal)
  })

  test('computeMACD histogram is positive during uptrend', ({ assert }) => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 2)
    const macd = QE.computeMACD(closes, 12, 26, 9)
    assert.isNotNull(macd)
    assert.isTrue(macd!.macd > 0)
  })

  // --- Bollinger Bands ---

  test('computeBollingerBands returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.computeBollingerBands([1, 2, 3], 20))
  })

  test('computeBollingerBands has correct structure', ({ assert }) => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 5)
    const bb = QE.computeBollingerBands(closes, 20, 2)
    assert.isNotNull(bb)
    assert.isTrue(bb!.upper > bb!.middle)
    assert.isTrue(bb!.middle > bb!.lower)
    assert.isTrue(bb!.width > 0)
    assert.isTrue(bb!.percentB >= -1 && bb!.percentB <= 2)
  })

  test('computeBollingerBands percentB is ~0.5 when price equals middle', ({ assert }) => {
    const closes = Array.from({ length: 25 }, () => 100)
    closes.push(100)
    // With constant prices, upper=lower=middle, percentB defaults to 0.5
    const bb = QE.computeBollingerBands(closes, 20, 2)
    assert.isNotNull(bb)
    assert.equal(bb!.percentB, 0.5)
  })

  // --- ATR ---

  test('computeATR returns null with insufficient data', ({ assert }) => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      date: `2025-01-0${i + 1}`, open: 100, high: 105, low: 95, close: 100, volume: 1000,
    }))
    assert.isNull(QE.computeATR(bars, 14))
  })

  test('computeATR returns positive value', ({ assert }) => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      open: 100 + (i % 2 === 0 ? 2 : -2),
      high: 105 + (i % 3),
      low: 95 - (i % 3),
      close: 100 + Math.sin(i) * 3,
      volume: 10000,
    }))
    const atr = QE.computeATR(bars, 14)
    assert.isNotNull(atr)
    assert.isTrue(atr! > 0)
  })

  // --- Stochastic ---

  test('computeStochastic returns null with insufficient data', ({ assert }) => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      date: '', open: 100, high: 110, low: 90, close: 100, volume: 1000,
    }))
    assert.isNull(QE.computeStochastic(bars, 14, 3))
  })

  test('computeStochastic %K is 100 at period high', ({ assert }) => {
    // Make close at the highest high of the period
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: '', open: 100, high: 100 + i, low: 90, close: i === 19 ? 119 : 100, volume: 1000,
    }))
    const stoch = QE.computeStochastic(bars, 14, 3)
    assert.isNotNull(stoch)
    assert.isTrue(stoch!.k > 90)
  })

  // --- ADX ---

  test('computeADX returns null with insufficient data', ({ assert }) => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: '', open: 100, high: 105, low: 95, close: 100, volume: 1000,
    }))
    assert.isNull(QE.computeADX(bars, 14))
  })

  test('computeADX returns valid structure for trending market', ({ assert }) => {
    const bars = Array.from({ length: 50 }, (_, i) => ({
      date: '', open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i, volume: 1000,
    }))
    const adx = QE.computeADX(bars, 14)
    assert.isNotNull(adx)
    assert.isTrue(adx!.adx > 0)
    assert.isTrue(adx!.plusDI > 0)
  })

  // --- OBV ---

  test('computeOBV accumulates volume directionally', ({ assert }) => {
    const bars = [
      { date: '', open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { date: '', open: 10, high: 12, low: 10, close: 11, volume: 200 },  // up
      { date: '', open: 11, high: 11, low: 9, close: 9, volume: 150 },    // down
      { date: '', open: 9, high: 10, low: 8, close: 10, volume: 100 },    // up
    ]
    const { obv, series } = QE.computeOBV(bars)
    assert.equal(series.length, 4)
    assert.equal(series[1], 200)     // +200 (up)
    assert.equal(series[2], 50)      // +200-150 (down)
    assert.equal(series[3], 150)     // +200-150+100 (up)
    assert.equal(obv, 150)
  })

  // --- Returns ---

  test('computeReturns calculates daily returns', ({ assert }) => {
    const returns = QE.computeReturns([100, 110, 99])
    assert.equal(returns.length, 2)
    assert.closeTo(returns[0], 0.1, 0.001)
    assert.closeTo(returns[1], -0.1, 0.001)
  })

  // --- Sharpe ---

  test('computeSharpe returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.computeSharpe([0.01, 0.02], 0))
  })

  test('computeSharpe is positive for positive excess returns', ({ assert }) => {
    const returns = Array.from({ length: 60 }, () => 0.005)
    const sharpe = QE.computeSharpe(returns, 0.0002)
    assert.isNotNull(sharpe)
    assert.isTrue(sharpe! > 0)
  })

  test('computeSharpe is negative for negative returns', ({ assert }) => {
    const returns = Array.from({ length: 60 }, (_, i) => -0.005 + (i % 2 === 0 ? 0.001 : -0.001))
    const sharpe = QE.computeSharpe(returns, 0.0002)
    assert.isNotNull(sharpe)
    assert.isTrue(sharpe! < 0)
  })

  // --- Sortino ---

  test('computeSortino penalizes only downside deviation', ({ assert }) => {
    const returns = Array.from({ length: 60 }, () => 0.005)
    const sortino = QE.computeSortino(returns, 0.0002)
    assert.isNotNull(sortino)
    assert.isTrue(sortino! > 0)
  })

  // --- Max Drawdown ---

  test('computeMaxDrawdown returns null with less than 2 points', ({ assert }) => {
    assert.isNull(QE.computeMaxDrawdown([100]))
  })

  test('computeMaxDrawdown detects peak-to-trough decline', ({ assert }) => {
    const closes = [100, 120, 90, 95, 80, 110]
    const dd = QE.computeMaxDrawdown(closes)
    // Peak 120, trough 80 → 33.3%
    assert.closeTo(dd!, 1 / 3, 0.01)
  })

  test('computeMaxDrawdown is 0 for always rising prices', ({ assert }) => {
    const closes = [100, 110, 120, 130]
    assert.equal(QE.computeMaxDrawdown(closes), 0)
  })

  // --- Beta ---

  test('computeBeta returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.computeBeta([0.01], [0.01]))
  })

  test('computeBeta is ~1 for identical returns', ({ assert }) => {
    const r = Array.from({ length: 60 }, () => Math.random() * 0.04 - 0.02)
    const beta = QE.computeBeta(r, r)
    assert.closeTo(beta!, 1, 0.01)
  })

  test('computeBeta is ~2 for 2x leveraged returns', ({ assert }) => {
    const bench = Array.from({ length: 60 }, () => Math.random() * 0.04 - 0.02)
    const leveraged = bench.map((r) => r * 2)
    const beta = QE.computeBeta(leveraged, bench)
    assert.closeTo(beta!, 2, 0.1)
  })

  // --- Price Change ---

  test('priceChange returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.priceChange([100, 110], 5))
  })

  test('priceChange computes percentage change', ({ assert }) => {
    const closes = [100, 105, 110, 115, 120]
    const change = QE.priceChange(closes, 2)
    // (120 - 110) / 110
    assert.closeTo(change!, 0.0909, 0.001)
  })

  // --- Signal Classification ---

  test('classifySignal maps scores to signals', ({ assert }) => {
    assert.equal(QE.classifySignal(50), 'strong_buy')
    assert.equal(QE.classifySignal(25), 'buy')
    assert.equal(QE.classifySignal(0), 'neutral')
    assert.equal(QE.classifySignal(-25), 'sell')
    assert.equal(QE.classifySignal(-50), 'strong_sell')
  })

  // --- Composite Score ---

  test('computeCompositeScore returns number', ({ assert }) => {
    const score = QE.computeCompositeScore(
      50, null, null, null, null, null, null, null, null, 0.05, 1.5, 1.0, 20, 100, []
    )
    assert.isNumber(score)
  })

  test('computeCompositeScore favors oversold RSI', ({ assert }) => {
    const oversold = QE.computeCompositeScore(
      25, null, null, null, null, null, null, null, null, null, null, null, null, 100, []
    )
    const overbought = QE.computeCompositeScore(
      75, null, null, null, null, null, null, null, null, null, null, null, null, 100, []
    )
    assert.isTrue(oversold > overbought)
  })
})
