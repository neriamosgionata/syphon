import { test } from '@japa/runner'
import { _internals } from '../../app/services/QuantEngine.js'

const QE: any = _internals

test.group('QuantEngine internals', () => {

  test('mean computes average', ({ assert }) => {
    assert.equal(QE.mean([1, 2, 3, 4, 5]), 3)
    assert.equal(QE.mean([10]), 10)
  })

  test('mean returns 0 for empty array', ({ assert }) => {
    assert.equal(QE.mean([]), 0)
  })

  test('stddev computes standard deviation', ({ assert }) => {
    const sd = QE.stddev([2, 4, 4, 4, 5, 5, 7, 9])
    assert.isTrue(sd > 1.9 && sd < 2.1)
  })

  test('stddev returns 0 for empty array', ({ assert }) => {
    assert.equal(QE.stddev([]), 0)
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
    const emaVal = result[result.length - 1]
    assert.isTrue(emaVal > 15)
    assert.isTrue(emaVal < 20)
  })

  // --- RSI ---

  test('computeRSI returns null with insufficient data', ({ assert }) => {
    assert.isNull(QE.computeRSI([1, 2, 3], 14))
  })

  test('computeRSI returns 100 for only gains', ({ assert }) => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    assert.equal(QE.computeRSI(closes, 14), 100)
  })

  test('computeRSI returns 50 for flat prices', ({ assert }) => {
    const closes = Array.from({ length: 20 }, () => 100)
    assert.equal(QE.computeRSI(closes, 14), 50)
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
    const bars = Array.from({ length: 5 }, () => ({
      date: '', open: 100, high: 110, low: 90, close: 100, volume: 1000,
    }))
    assert.isNull(QE.computeStochastic(bars, 14, 3))
  })

  test('computeStochastic %K is 100 at period high', ({ assert }) => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: '', open: 100, high: 100 + i, low: 90, close: i === 19 ? 119 : 100, volume: 1000,
    }))
    const stoch = QE.computeStochastic(bars, 14, 3)
    assert.isNotNull(stoch)
    assert.isTrue(stoch!.k > 90)
  })

  // --- ADX ---

  test('computeADX returns null with insufficient data', ({ assert }) => {
    const bars = Array.from({ length: 20 }, () => ({
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
      { date: '', open: 10, high: 12, low: 10, close: 11, volume: 200 },
      { date: '', open: 11, high: 11, low: 9, close: 9, volume: 150 },
      { date: '', open: 9, high: 10, low: 8, close: 10, volume: 100 },
    ]
    const { obv, series } = QE.computeOBV(bars)
    assert.equal(series.length, 4)
    assert.equal(series[1], 200)
    assert.equal(series[2], 50)
    assert.equal(series[3], 150)
    assert.equal(obv, 150)
  })

  // --- Returns ---

  test('computeReturns calculates daily returns', ({ assert }) => {
    const returns = QE.computeReturns([100, 110, 99])
    assert.equal(returns.length, 2)
    assert.closeTo(returns[0], 0.1, 0.001)
    assert.closeTo(returns[1], -0.1, 0.001)
  })

  test('computeReturns handles zero prices', ({ assert }) => {
    const returns = QE.computeReturns([0, 100, 200])
    assert.equal(returns[0], 0)
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

  test('computeSortino caps value for no downside', ({ assert }) => {
    const returns = Array.from({ length: 60 }, () => 0.005)
    const sortino = QE.computeSortino(returns, 0.0002)
    assert.isTrue(sortino! <= 10)
  })

  // --- Max Drawdown ---

  test('computeMaxDrawdown returns null with less than 2 points', ({ assert }) => {
    assert.isNull(QE.computeMaxDrawdown([100]))
  })

  test('computeMaxDrawdown detects peak-to-trough decline', ({ assert }) => {
    const closes = [100, 120, 90, 95, 80, 110]
    const dd = QE.computeMaxDrawdown(closes)
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

  // --- Composite Score (object-based) ---

  test('computeCompositeScore returns number and breakdown', ({ assert }) => {
    const { score, breakdown } = QE.computeCompositeScore({
      rsi: 50, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: 0.05,
      sharpe: 1.5, beta: 1.0, pe: 20, price: 100, patterns: [],
      sentiment: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    assert.isNumber(score)
    assert.property(breakdown, 'rsi')
    assert.property(breakdown, 'sentiment')
    assert.property(breakdown, 'fiftyTwoWeek')
  })

  test('computeCompositeScore favors oversold RSI', ({ assert }) => {
    const { score: oversold } = QE.computeCompositeScore({
      rsi: 25, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: null,
      sharpe: null, beta: null, pe: null, price: 100, patterns: [],
      sentiment: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    const { score: overbought } = QE.computeCompositeScore({
      rsi: 75, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: null,
      sharpe: null, beta: null, pe: null, price: 100, patterns: [],
      sentiment: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    assert.isTrue(oversold > overbought)
  })

  test('computeCompositeScore includes sentiment', ({ assert }) => {
    const { score: withSentiment } = QE.computeCompositeScore({
      rsi: 50, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: null,
      sharpe: null, beta: null, pe: null, price: 100, patterns: [],
      sentiment: { totalArticles: 10, avgScore: 0.8, recentTrend: 0.2 },
      fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    const { score: noSentiment } = QE.computeCompositeScore({
      rsi: 50, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: null,
      sharpe: null, beta: null, pe: null, price: 100, patterns: [],
      sentiment: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    assert.isTrue(withSentiment > noSentiment)
  })

  test('computeCompositeScore includes patterns', ({ assert }) => {
    const { score: withBullish } = QE.computeCompositeScore({
      rsi: 50, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: null,
      sharpe: null, beta: null, pe: null, price: 100,
      patterns: [{ name: 'golden_cross', type: 'bullish', strength: 0.85, description: '' }],
      sentiment: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    const { score: noPatterns } = QE.computeCompositeScore({
      rsi: 50, macd: null, bb: null, sma20: null, sma50: null, sma200: null,
      adx: null, stoch: null, volumeRatio: null, return20d: null,
      sharpe: null, beta: null, pe: null, price: 100, patterns: [],
      sentiment: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, regime: 'unknown',
    })
    assert.isTrue(withBullish > noPatterns)
  })

  // --- Regime Detection ---

  test('detectRegime identifies trending up', ({ assert }) => {
    const adx = { adx: 30, plusDI: 25, minusDI: 15, series: [] }
    assert.equal(QE.detectRegime(adx, 100, 95, 0.2, 105), 'trending_up')
  })

  test('detectRegime identifies trending down', ({ assert }) => {
    const adx = { adx: 30, plusDI: 12, minusDI: 28, series: [] }
    assert.equal(QE.detectRegime(adx, 100, 105, 0.2, 95), 'trending_down')
  })

  test('detectRegime identifies volatile', ({ assert }) => {
    assert.equal(QE.detectRegime(null, 100, 95, 0.40, 105), 'volatile')
  })

  test('detectRegime identifies ranging with low ADX', ({ assert }) => {
    const adx = { adx: 15, plusDI: 18, minusDI: 17, series: [] }
    assert.equal(QE.detectRegime(adx, 100, 95, 0.15, 100), 'ranging')
  })

  // --- Conviction ---

  test('computeConviction is high when indicators agree', ({ assert }) => {
    const breakdown = {
      rsi: 50, macd: 40, bollingerBands: 30, trend: 60, adx: 40,
      stochastic: 30, momentum: 50, volume: 20, patterns: 40,
      sentiment: 60, sentimentMomentum: 30, newsVolume: 20,
      sharpe: 30, beta: 0, pe: 20, fiftyTwoWeek: 30,
    }
    const conviction = QE.computeConviction(breakdown, 40)
    assert.isTrue(conviction > 0.5)
  })

  test('computeConviction is low when indicators disagree', ({ assert }) => {
    const breakdown = {
      rsi: 50, macd: -40, bollingerBands: 30, trend: -60, adx: 40,
      stochastic: -30, momentum: 50, volume: -20, patterns: 40,
      sentiment: -60, sentimentMomentum: 30, newsVolume: -20,
      sharpe: 30, beta: 0, pe: -20, fiftyTwoWeek: 30,
    }
    const conviction = QE.computeConviction(breakdown, 5)
    assert.isTrue(conviction < 0.3)
  })
})
