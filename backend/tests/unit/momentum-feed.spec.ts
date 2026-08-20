import { test } from '@japa/runner'
import { MomentumFeed, wildersRsi, binCloses } from '../../app/services/MomentumFeed.js'

test.group('MomentumFeed', (group) => {
  let feed: MomentumFeed

  group.each.setup(() => {
    feed = new MomentumFeed()
  })

  test('momentumPct measures change over the window', ({ assert }) => {
    const t0 = 1000000
    feed.push('BTC', 100, t0)
    feed.push('BTC', 101, t0 + 1000)
    feed.push('BTC', 102, t0 + 2000)

    // window smaller than series age: price 1000ms ago = 101
    assert.equal(feed.momentumPct('BTC', 1, t0 + 2000), (102 - 101) / 101 * 100)
    // window beyond series age: null
    assert.isNull(feed.momentumPct('BTC', 3600, t0 + 2000))
    // no data
    assert.isNull(feed.momentumPct('ETH', 60, t0 + 2000))
  })

  test('priceAt returns the sample inside the window boundary', ({ assert }) => {
    const t0 = 1000000
    feed.push('BTC', 100, t0)
    feed.push('BTC', 105, t0 + 5000)
    feed.push('BTC', 110, t0 + 10000)

    assert.equal(feed.priceAt('BTC', 5, t0 + 10000), 105)
    assert.equal(feed.priceAt('BTC', 10, t0 + 10000), 100)
    assert.isNull(feed.priceAt('BTC', 60, t0 + 10000))
  })

  test('ignores non-positive and non-finite prices', ({ assert }) => {
    const t0 = 1000000
    feed.push('BTC', 0, t0)
    feed.push('BTC', NaN, t0 + 1000)
    feed.push('BTC', -5, t0 + 2000)
    feed.push('BTC', 100, t0 + 3000)
    assert.equal(feed.sampleCount('BTC'), 1)
    assert.equal(feed.lastPrice('BTC'), 100)
  })

  test('wildersRsi returns 100 on all-gains series', ({ assert }) => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    assert.equal(wildersRsi(closes, 14), 100)
  })

  test('wildersRsi returns 0 on all-losses series', ({ assert }) => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i)
    assert.equal(wildersRsi(closes, 14), 0)
  })

  test('wildersRsi returns 50 on flat series', ({ assert }) => {
    const closes = Array.from({ length: 20 }, () => 100)
    assert.equal(wildersRsi(closes, 14), 50)
  })

  test('wildersRsi needs period + 1 closes', ({ assert }) => {
    assert.isNull(wildersRsi([100, 101, 102], 14))
  })

  test('binCloses buckets samples into latest-close-per-bucket', ({ assert }) => {
    const t0 = 1000000
    const samples = [
      { t: t0, p: 100 },
      { t: t0 + 1000, p: 101 },
      { t: t0 + 2000, p: 102 },
      { t: t0 + 6000, p: 106 },
      { t: t0 + 7000, p: 107 },
    ]
    const closes = binCloses(samples, 5, t0 + 7000)
    assert.deepEqual(closes, [102, 107])
  })

  test('score passes when momentum clears threshold', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i <= 120; i++) feed.push('BTC', 100 + i * 0.02, t0 + i * 1000)
    // steady rally pins RSI at 100, so widen the RSI gate: this test targets
    // the momentum gate specifically
    const result = feed.score('BTC', { windowSeconds: 60, thresholdPct: 0.1, rsiLow: 0, rsiHigh: 1000, now: t0 + 120000 })
    assert.isTrue(result.pass)
    assert.isAbove(result.momentumPct!, 0.1)
  })

  test('score fails when momentum below threshold', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i <= 120; i++) feed.push('BTC', 100, t0 + i * 1000)
    const result = feed.score('BTC', { windowSeconds: 60, thresholdPct: 0.1, rsiLow: 35, rsiHigh: 75, now: t0 + 120000 })
    assert.isFalse(result.pass)
    assert.match(result.reason, /momentum/)
  })

  test('score fails when RSI overbought despite momentum', ({ assert }) => {
    const t0 = 1000000
    // strong rally: momentum positive AND RSI pinned at 100
    for (let i = 0; i <= 300; i++) feed.push('BTC', 100 + i, t0 + i * 1000)
    const result = feed.score('BTC', { windowSeconds: 60, thresholdPct: 1, rsiLow: 35, rsiHigh: 75, now: t0 + 300000 })
    assert.isFalse(result.pass)
    assert.match(result.reason, /overbought|weak/)
  })

  test('score is lenient when RSI data is still warming up', ({ assert }) => {
    const t0 = 1000000
    feed.push('BTC', 100, t0)
    feed.push('BTC', 101, t0 + 1000)
    const result = feed.score('BTC', { windowSeconds: 1, thresholdPct: 0.5, rsiLow: 35, rsiHigh: 75, now: t0 + 1000 })
    assert.isTrue(result.pass)
    assert.isNull(result.rsi)
  })

  test('score fails without any data', ({ assert }) => {
    const result = feed.score('BTC', { windowSeconds: 60, thresholdPct: 0.1, rsiLow: 35, rsiHigh: 75 })
    assert.isFalse(result.pass)
  })

  test('clear removes a symbol series', ({ assert }) => {
    feed.push('BTC', 100, 1000000)
    feed.clear('BTC')
    assert.isNull(feed.lastPrice('BTC'))
  })

  test('ema follows a rising series below the price', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 40; i++) feed.push('BTC', 100 + i, t0 + i * 1000)
    const ema = feed.ema('BTC', 20, t0 + 40000)
    assert.isNotNull(ema)
    assert.isBelow(ema!, feed.lastPrice('BTC')!)
    assert.isAbove(ema!, 100) // lagging the rally, not detached
  })

  test('ema is flat on a flat series', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 40; i++) feed.push('BTC', 100, t0 + i * 1000)
    assert.closeTo(feed.ema('BTC', 20, t0 + 40000)!, 100, 1e-9)
  })

  test('ema needs period samples', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 10; i++) feed.push('BTC', 100 + i, t0 + i * 1000)
    assert.isNull(feed.ema('BTC', 20, t0 + 10000))
  })

  test('ema disabled for non-positive periods', ({ assert }) => {
    feed.push('BTC', 100, 1000000)
    assert.isNull(feed.ema('BTC', 0, 1000000))
  })

  test('volatilityPct is ~0 on a flat series', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 120; i++) feed.push('BTC', 100, t0 + i * 1000)
    assert.closeTo(feed.volatilityPct('BTC', 60, t0 + 120000)!, 0, 1e-9)
  })

  test('volatilityPct measures per-sample swing', ({ assert }) => {
    const t0 = 1000000
    // ±1% zigzag every second → alternating ±2% returns → stddev ≈ 2%
    for (let i = 0; i < 120; i++) feed.push('BTC', 100 + (i % 2 === 0 ? 1 : -1), t0 + i * 1000)
    const vol = feed.volatilityPct('BTC', 60, t0 + 120000)
    assert.isNotNull(vol)
    assert.closeTo(vol!, 2.0, 0.05)
  })

  test('volatilityPct needs window + 1 samples', ({ assert }) => {
    for (let i = 0; i < 10; i++) feed.push('BTC', 100, 1000000 + i * 1000)
    assert.isNull(feed.volatilityPct('BTC', 60, 1000000 + 10000))
    assert.isNull(feed.volatilityPct('BTC', 0, 1000000 + 10000))
  })

  test('emaSlopePct is positive on a rising series', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 4000; i++) feed.push('BTC', 100 + i * 0.01, t0 + i * 1000)
    const slope = feed.emaSlopePct('BTC', 300, 1800, t0 + 4000000)
    assert.isNotNull(slope)
    assert.isAbove(slope!, 0)
  })

  test('emaSlopePct is ~0 on a flat series and negative on a falling one', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 4000; i++) feed.push('BTC', 100, t0 + i * 1000)
    assert.closeTo(feed.emaSlopePct('BTC', 300, 1800, t0 + 4000000)!, 0, 1e-9)

    feed.clear('BTC')
    for (let i = 0; i < 4000; i++) feed.push('BTC', 100 - i * 0.01, t0 + i * 1000)
    assert.isBelow(feed.emaSlopePct('BTC', 300, 1800, t0 + 4000000)!, 0)
  })

  test('emaSlopePct is null while the slope window has not filled', ({ assert }) => {
    const t0 = 1000000
    for (let i = 0; i < 2000; i++) feed.push('BTC', 100 + i * 0.01, t0 + i * 1000)
    // boundary falls before the EMA can seed (300 samples) → null
    assert.isNull(feed.emaSlopePct('BTC', 300, 1800, t0 + 2000000))
    assert.isNull(feed.emaSlopePct('BTC', 0, 1800, t0 + 2000000))
  })
})
