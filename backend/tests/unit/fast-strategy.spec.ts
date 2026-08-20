import { test } from '@japa/runner'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import { FastStrategy, FastStrategyConfig } from '../../app/services/FastStrategy.js'

// FastStrategy is the pure deterministic entry/exit core shared by the
// live loop and the backtester. All tests are synthetic price series fed
// into a real MomentumFeed with explicit timestamps — no DB, no WS.

const strategy = new FastStrategy()

function feedFrom(priceFn: (i: number) => number, count: number, t0 = 1_000_000, step = 1000): { feed: MomentumFeed; now: number } {
  const feed = new MomentumFeed()
  for (let i = 0; i < count; i++) feed.push('BTC', priceFn(i), t0 + i * step)
  return { feed, now: t0 + (count - 1) * step }
}

function baseCfg(overrides: Partial<FastStrategyConfig> = {}): FastStrategyConfig {
  return {
    momentumSeconds: 60,
    momentumThresholdPct: 0.1,
    rsiLow: 0,
    rsiHigh: 1000, // RSI gate disabled unless the test enables it
    stopLossPct: 0.5,
    takeProfitPct: 1.0,
    exitReversalPct: -0.3,
    trailingStopPct: 0,
    trailingActivatePct: 0,
    maxHoldSeconds: 0,
    emaPeriod: 0,
    volatilityWindowSamples: 0,
    volatilityMult: 0,
    volatilityFloorPct: 0.05,
    volatilityCeilingPct: 0,
    ...overrides,
  }
}

function buyPosition(overrides: Partial<Parameters<typeof strategy.evaluateExit>[4]> = {}) {
  return {
    side: 'BUY' as const,
    entryPrice: 100,
    stopLoss: 99.5,
    takeProfit: 101,
    peakPrice: null,
    openedAt: 1_000_000,
    ...overrides,
  }
}

test.group('FastStrategy entry', () => {
  test('passes when momentum clears threshold', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, baseCfg())
    assert.isTrue(signal.shouldEnter)
    assert.isAbove(signal.momentumPct!, 0.1)
    assert.isNotNull(signal.stopLoss)
    assert.isNotNull(signal.takeProfit)
  })

  test('fails when momentum below threshold', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 180)
    const signal = strategy.evaluateEntry(feed, 'BTC', 100, now, baseCfg())
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /momentum/)
  })

  test('fails when RSI overbought', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i, 300)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, baseCfg({ rsiHigh: 75 }))
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /overbought|weak/)
  })

  test('EMA trend filter blocks entry when price below EMA', ({ assert }) => {
    // Spike up, then a fast crash: momentum vs 60s ago still positive
    // (price 97 vs 95 sixty seconds back) while the 20-sample average
    // (~99.5) sits above the price.
    const { feed, now } = feedFrom((i) => {
      if (i <= 40) return 95
      if (i <= 75) return 95 + (i - 41) * (10 / 34)
      return 105 - (i - 75) * (8 / 25)
    }, 101)
    const price = feed.lastPrice('BTC')!
    const signal = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg({ emaPeriod: 20 }))
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /EMA/)
    assert.isAbove(signal.ema!, price)
  })

  test('EMA filter is lenient while warming up', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.05, 15, 1_000_000, 1000)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ momentumSeconds: 10, emaPeriod: 20 })
    )
    assert.isTrue(signal.shouldEnter)
    assert.isNull(signal.ema)
  })

  test('volatility ceiling blocks entry in wild markets', ({ assert }) => {
    // ±1% zigzag every second with upward drift: momentum strongly
    // positive, but per-second vol ~2% → per-minute ~15.5% > ceiling 1%.
    const { feed, now } = feedFrom((i) => 100 + i * 0.5 + (i % 2 === 0 ? 1 : -1), 180)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ volatilityWindowSamples: 60, volatilityCeilingPct: 1 })
    )
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /volatility/)
  })

  test('volatility ceiling does not block calm markets', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ volatilityWindowSamples: 60, volatilityCeilingPct: 5 })
    )
    assert.isTrue(signal.shouldEnter)
  })
})

test.group('FastStrategy entry levels', () => {
  test('uses base percentages in calm markets', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const levels = strategy.entryLevels(feed, 'BTC', 100, now, baseCfg(), null)
    assert.closeTo(levels.stopLoss, 99.5, 1e-9)
    assert.closeTo(levels.takeProfit, 101, 1e-9)
    assert.equal(levels.stopLossPct, 0.5)
    assert.equal(levels.takeProfitPct, 1.0)
  })

  test('widens SL/TP proportionally when volatility is high', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + (i % 2 === 0 ? 1 : -1), 120)
    // vol ≈ 1%/s → per-minute ≈ 7.75% → scaled SL = 2 × 7.75 = 15.5%
    const levels = strategy.entryLevels(feed, 'BTC', 100, now, baseCfg({
      volatilityWindowSamples: 60,
      volatilityMult: 2,
    }), null)
    assert.isAbove(levels.stopLossPct, 0.5)
    assert.isAbove(levels.takeProfitPct, 1.0)
    // TP scales by the same factor as SL (risk/reward preserved)
    assert.closeTo(levels.takeProfitPct, levels.stopLossPct * 2, 0.1)
    assert.closeTo(levels.stopLoss, 100 * (1 - levels.stopLossPct / 100), 1e-6)
  })

  test('uses measured volatility when provided', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const levels = strategy.entryLevels(feed, 'BTC', 100, now, baseCfg({
      volatilityWindowSamples: 60,
      volatilityMult: 2,
    }), 2.0)
    assert.closeTo(levels.stopLossPct, 2 * 2.0 * Math.sqrt(60), 0.001)
  })
})

test.group('FastStrategy exit', () => {
  test('fixed stop loss', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(feed, 'BTC', 99.4, now, buyPosition(), baseCfg())
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /stop-loss/)
  })

  test('fixed take profit', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(feed, 'BTC', 101.2, now, buyPosition(), baseCfg())
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /take-profit/)
  })

  test('trailing stop not armed below activation threshold', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4 })
    const signal = strategy.evaluateExit(feed, 'BTC', 100.2, now, buyPosition(), cfg)
    assert.isFalse(signal.shouldExit)
    assert.isNull(signal.trailingStop)
    assert.equal(signal.peakPrice, 100.2)
  })

  test('trailing stop arms above activation and ratchets', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4 })
    let pos = buyPosition({ takeProfit: 150 })

    // Peak at 100.9 → gain 0.9% ≥ 0.4% → trail = 100.9 × 0.997 = 100.5973
    let signal = strategy.evaluateExit(feed, 'BTC', 100.9, now, pos, cfg)
    assert.isFalse(signal.shouldExit)
    assert.isNotNull(signal.trailingStop)
    assert.closeTo(signal.trailingStop!, 100.5973, 1e-9)
    assert.isAbove(signal.trailingStop!, pos.stopLoss)

    // Persist like the live loop does. Then a new peak (101.5) tightens the
    // trail to 101.1955 and price drops into it in the same tick → the
    // trailing reason fires (price is above the old persisted stop).
    pos = { ...pos, stopLoss: signal.trailingStop!, peakPrice: signal.peakPrice }
    signal = strategy.evaluateExit(feed, 'BTC', 101.1, now, { ...pos, peakPrice: 101.5 }, cfg)
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /trailing stop/)
    assert.closeTo(signal.trailingStop!, 101.1955, 1e-9)
  })

  test('trailing stop never loosens on a pullback', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4 })
    let pos = buyPosition({ takeProfit: 150 })

    const first = strategy.evaluateExit(feed, 'BTC', 101, now, pos, cfg)
    pos = { ...pos, stopLoss: first.trailingStop!, peakPrice: first.peakPrice }

    // Price pulls back to 100.5 then rallies to 100.9 — new peak (100.9)
    // is below the old peak (101), so the trail must not loosen.
    const second = strategy.evaluateExit(feed, 'BTC', 100.9, now, pos, cfg)
    assert.isFalse(second.shouldExit)
    assert.closeTo(second.trailingStop!, 100.697, 1e-9)
    assert.equal(second.peakPrice, 101)

    // New all-time high at 102 ratchets the trail up.
    const third = strategy.evaluateExit(feed, 'BTC', 102, now, pos, cfg)
    assert.closeTo(third.trailingStop!, 102 * 0.997, 1e-6)
    assert.equal(third.peakPrice, 102)
  })

  test('max hold force-closes after the configured window', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = baseCfg({ maxHoldSeconds: 300 })
    const signal = strategy.evaluateExit(
      feed, 'BTC', 100.1, now, buyPosition({ openedAt: now - 400_000 }), cfg
    )
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /max hold/)
  })

  test('max hold disabled (0) never time-exits', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(
      feed, 'BTC', 100.1, now, buyPosition({ openedAt: now - 400_000 }), baseCfg()
    )
    assert.isFalse(signal.shouldExit)
  })

  test('momentum reversal exit', ({ assert }) => {
    // Rise to 140 over the first 60s, then crash to 126: momentum vs 60s
    // ago = (126-140)/140 = -10% ≤ -0.3%, while price is inside SL/TP.
    const { feed, now } = feedFrom((i) => {
      if (i <= 60) return 100 + (140 - 100) * (i / 60)
      return 140 - (140 - 126) * ((i - 60) / 60)
    }, 121)
    const price = feed.lastPrice('BTC')!
    const signal = strategy.evaluateExit(
      feed, 'BTC', price, now,
      buyPosition({ entryPrice: 100, stopLoss: 50, takeProfit: 500 }),
      baseCfg()
    )
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /momentum reversal/)
  })

  test('SELL positions mirror stop loss and trailing', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const pos = { side: 'SELL' as const, entryPrice: 100, stopLoss: 100.5, takeProfit: 99, peakPrice: null, openedAt: 1_000_000 }

    const sl = strategy.evaluateExit(feed, 'BTC', 100.6, now, pos, baseCfg())
    assert.isTrue(sl.shouldExit)
    assert.match(sl.reason!, /stop-loss/)

    const cfg = baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4 })
    // Price falls to 99.1 (gain 0.9%) → trail = 99.1 × 1.003 = 99.3973
    const trail = strategy.evaluateExit(feed, 'BTC', 99.1, now, pos, cfg)
    assert.isFalse(trail.shouldExit)
    assert.closeTo(trail.trailingStop!, 99.3973, 1e-9)
    assert.equal(trail.peakPrice, 99.1)

    // New low peak (98.8) tightens the trail to 99.0964; price at 99.2 sits
    // inside it → trailing exit (price is far from the SELL stop-loss).
    const breached = strategy.evaluateExit(
      feed, 'BTC', 99.2, now, { ...pos, stopLoss: trail.trailingStop!, peakPrice: 98.8 }, cfg
    )
    assert.isTrue(breached.shouldExit)
    assert.match(breached.reason!, /trailing stop/)
    assert.closeTo(breached.trailingStop!, 99.0964, 1e-9)
  })

  test('holds when nothing fires', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(feed, 'BTC', 100.2, now, buyPosition(), baseCfg())
    assert.isFalse(signal.shouldExit)
    assert.isNull(signal.reason)
  })
})
