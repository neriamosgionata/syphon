import { test } from '@japa/runner'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import { FastStrategy, FastStrategyConfig, fastStrategyFromConfig, volatilityMultiplier } from '../../app/services/FastStrategy.js'

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
    harVolForecast: false,
    cusumWindowSeconds: 0,
    cusumExitPct: 0,
    jumpSlackPct: 0,
    choppinessPeriod: 0,
    choppinessMax: 0,
    tradeStartUtc: 0,
    tradeEndUtc: 24,
    convictionSizing: false,
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

test.group('FastStrategy trend mode', () => {
  function trendCfg(overrides: Partial<FastStrategyConfig> = {}): FastStrategyConfig {
    return baseCfg({
      trendMode: true,
      emaPeriod: 300,
      trendSlopePct: 0.05,
      trendSlopeWindowSeconds: 1800,
      takeProfitPct: 0, // ride the trailing stop, no fixed TP
      ...overrides,
    })
  }

  test('enters a steady rally the momentum gate would sleep through', ({ assert }) => {
    // +0.001%/s ≈ +3.6%/h: 60s momentum = +0.06% < 0.15% threshold (burst
    // gate blocks) and RSI pins at 100 — but trend mode must still enter.
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 3600)
    const price = feed.lastPrice('BTC')!
    const momSignal = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg())
    assert.isFalse(momSignal.shouldEnter)

    const signal = strategy.evaluateEntry(feed, 'BTC', price, now, trendCfg())
    assert.isTrue(signal.shouldEnter)
    assert.match(signal.reason!, /trend:/)
    assert.isAbove(signal.ema!, 100)
  })

  test('blocks when price is below the EMA (declining market)', ({ assert }) => {
    // Linear decline: EMA lags above the price.
    const { feed, now } = feedFrom((i) => 100 - 0.0005 * i, 3600)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, trendCfg())
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /EMA|slope/)
  })

  test('blocks when the EMA slope is below the threshold', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 3600)
    const signal = strategy.evaluateEntry(feed, 'BTC', 100, now, trendCfg())
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /EMA|slope/)
  })

  test('slope gate is lenient while the slope window is warming', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 2000)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, trendCfg())
    assert.isTrue(signal.shouldEnter)
    assert.match(signal.reason!, /slope warming/)
  })

  test('trend mode requires an EMA period', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 500)
    const signal = strategy.evaluateEntry(feed, 'BTC', 100, now, trendCfg({ emaPeriod: 0 }))
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /fastEmaPeriod/)
  })

  test('takeProfitPct 0 produces no take-profit level and never TP-exits', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = trendCfg()
    const signal = strategy.evaluateEntry(feed, 'BTC', 100, now, cfg)
    if (signal.shouldEnter) {
      assert.equal(signal.takeProfit, 0)
    }
    const exit = strategy.evaluateExit(
      feed, 'BTC', 101.2, now,
      buyPosition({ entryPrice: 100, stopLoss: 95, takeProfit: 0 }),
      baseCfg()
    )
    assert.isFalse(exit.shouldExit)
  })
})

test.group('FastStrategy regime gate', () => {
  function regimeCfg(overrides: Partial<FastStrategyConfig> = {}): FastStrategyConfig {
    return baseCfg({
      trendMode: true,
      emaPeriod: 900,
      trendSlopePct: 0.1,
      trendSlopeWindowSeconds: 1800,
      takeProfitPct: 0,
      regimeEmaPeriod: 3600,
      regimeSlopeWindowSeconds: 3600,
      regimeSlopeMinPct: 0.02,
      ...overrides,
    })
  }

  test('stands aside in a flat market (no trend on the slow EMA)', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 10800)
    const signal = strategy.evaluateEntry(feed, 'BTC', 100, now, regimeCfg())
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /regime/)
  })

  test('enters when the slow EMA slope confirms a trend', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 10800)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, regimeCfg())
    assert.isTrue(signal.shouldEnter)
  })

  test('regime gate is lenient while the slow EMA is warming up', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 4200)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, regimeCfg())
    assert.isTrue(signal.shouldEnter)
  })

  test('regime gate disabled (period 0) never blocks', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 10800)
    const signal = strategy.evaluateEntry(feed, 'BTC', 100, now, regimeCfg({ regimeEmaPeriod: 0 }))
    // flat market: falls through to the price-vs-EMA check instead
    assert.isFalse(signal.shouldEnter)
    assert.notMatch(signal.reason!, /regime/)
  })
})

test.group('FastStrategy volume gate', () => {
  function volCfg(overrides: Partial<FastStrategyConfig> = {}): FastStrategyConfig {
    return baseCfg({
      volumeWindowSamples: 300,
      volumeMinRatio: 1.0,
      ...overrides,
    })
  }

  test('blocks entry when the bar volume is below the rolling median', ({ assert }) => {
    const t0 = 1000000
    const feed = new MomentumFeed()
    for (let i = 0; i < 300; i++) feed.push('BTC', 100 + i * 0.02, t0 + i * 1000, 100)
    feed.push('BTC', 106, t0 + 300_000, 40) // low-volume momentum bar
    const signal = strategy.evaluateEntry(feed, 'BTC', 106, t0 + 300_000, volCfg())
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /volume/)
  })

  test('passes when the bar volume clears the median', ({ assert }) => {
    const t0 = 1000000
    const feed = new MomentumFeed()
    for (let i = 0; i < 300; i++) feed.push('BTC', 100 + i * 0.02, t0 + i * 1000, 100)
    feed.push('BTC', 106, t0 + 300_000, 200)
    const signal = strategy.evaluateEntry(feed, 'BTC', 106, t0 + 300_000, volCfg())
    assert.isTrue(signal.shouldEnter)
  })

  test('lenient when the feed carries no volume (live mode)', ({ assert }) => {
    const t0 = 1000000
    const feed = new MomentumFeed()
    for (let i = 0; i < 300; i++) feed.push('BTC', 100 + i * 0.02, t0 + i * 1000)
    feed.push('BTC', 106, t0 + 300_000)
    const signal = strategy.evaluateEntry(feed, 'BTC', 106, t0 + 300_000, volCfg())
    assert.isTrue(signal.shouldEnter)
  })

  test('disabled (ratio 0) never blocks', ({ assert }) => {
    const t0 = 1000000
    const feed = new MomentumFeed()
    for (let i = 0; i < 300; i++) feed.push('BTC', 100 + i * 0.02, t0 + i * 1000, 100)
    feed.push('BTC', 106, t0 + 300_000, 10)
    const signal = strategy.evaluateEntry(feed, 'BTC', 106, t0 + 300_000, volCfg({ volumeMinRatio: 0 }))
    assert.isTrue(signal.shouldEnter)
  })
})

test.group('volatilityMultiplier', () => {
  test('scales exposure to hit the target annualized vol', ({ assert }) => {
    // 0.0068%/s ≈ 38% annualized → target 50% → mult ≈ 1.31
    const m = volatilityMultiplier(0.0068, 50, 2)
    assert.isAbove(m, 1)
    assert.isBelow(m, 2)
    assert.closeTo(m, 50 / (0.0068 * Math.sqrt(31_536_000)), 0.05)
  })

  test('de-risks when realized vol exceeds the target', ({ assert }) => {
    const m = volatilityMultiplier(0.03, 50, 2) // 168% annualized → mult 0.3
    assert.isAbove(m, 0.2)
    assert.isBelow(m, 1)
  })

  test('clamps to maxMult and the 0.2 floor', ({ assert }) => {
    assert.equal(volatilityMultiplier(0.0001, 50, 2), 2)
    assert.equal(volatilityMultiplier(1.0, 50, 2), 0.2)
    assert.equal(volatilityMultiplier(null, 50, 2), 1)
    assert.equal(volatilityMultiplier(0.0068, 0, 2), 1) // target off
  })
})

test.group('FastStrategy exit quality', () => {
  test('vol-adaptive trailing widens the trail in high volatility', ({ assert }) => {
    // ±1% zigzag every second → per-second vol ≈ 2% → per-minute ≈ 15.5%
    const { feed, now } = feedFrom((i) => 100 + (i % 2 === 0 ? 1 : -1), 120)
    const cfg = baseCfg({
      trailingStopPct: 0.3,
      trailingActivatePct: 0.4,
      trailingVolatilityMult: 2,
      volatilityWindowSamples: 60,
      volatilityFloorPct: 0.05,
    })
    const pos = buyPosition({ takeProfit: 150, peakPrice: 100 })
    const signal = strategy.evaluateExit(feed, 'BTC', 100.9, now, pos, cfg)
    assert.isFalse(signal.shouldExit)
    assert.isNotNull(signal.trailingStop)
    // trail = 100.9 × (1 - max(0.3, 2 × 15.49)) — far wider than fixed 0.3%
    assert.isBelow(signal.trailingStop!, 100.9 * (1 - 0.003) - 1)
  })

  test('scale-out fires exactly once when the trail arms', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4, scaleOutPct: 0.5 })
    let pos = buyPosition({ takeProfit: 150 })

    const first = strategy.evaluateExit(feed, 'BTC', 100.9, now, pos, cfg)
    assert.isTrue(first.scaleOut)

    // Already scaled out → no second signal.
    pos = { ...pos, scaledOut: true }
    const second = strategy.evaluateExit(feed, 'BTC', 101.2, now, pos, cfg)
    assert.isFalse(second.scaleOut)

    // scaleOutPct 0 never fires.
    const noSo = strategy.evaluateExit(feed, 'BTC', 100.9, now, buyPosition({ takeProfit: 150 }), baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4 }))
    assert.isFalse(noSo.scaleOut)
  })

  test('scale-out never fires before the trail arms', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const cfg = baseCfg({ trailingStopPct: 0.3, trailingActivatePct: 0.4, scaleOutPct: 0.5 })
    const signal = strategy.evaluateExit(feed, 'BTC', 100.2, now, buyPosition({ takeProfit: 150 }), cfg)
    assert.isFalse(signal.scaleOut)
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

test.group('FastStrategy session gate', () => {
  test('blocks entries outside the configured UTC window', ({ assert }) => {
    // t0 = 10_000_000 ms = 02:46 UTC → hour 2, outside [6, 12).
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180, 10_000_000)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ tradeStartUtc: 6, tradeEndUtc: 12 })
    )
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /session/)
  })

  test('allows entries inside the configured UTC window', ({ assert }) => {
    // t0 = 10h exactly → hour 10, inside [6, 12).
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180, 10 * 3600_000)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ tradeStartUtc: 6, tradeEndUtc: 12 })
    )
    assert.isTrue(signal.shouldEnter)
  })

  test('disabled by default (0-24) never blocks', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180, 10_000_000)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, baseCfg())
    assert.isTrue(signal.shouldEnter)
  })
})

test.group('FastStrategy choppiness gate', () => {
  test('blocks entries in a ranging (high-CHOP) market', ({ assert }) => {
    // ±1 zigzag with flat momentum-relevant window: CHOP ≈ 85 > 50.
    const { feed, now } = feedFrom((i) => 100 + (i % 2 === 0 ? 1 : -1), 180)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ choppinessPeriod: 120, choppinessMax: 50 })
    )
    assert.isFalse(signal.shouldEnter)
    assert.match(signal.reason!, /choppiness/)
  })

  test('passes a trending (low-CHOP) market', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ choppinessPeriod: 120, choppinessMax: 50 })
    )
    assert.isTrue(signal.shouldEnter)
  })

  test('disabled (period 0) never blocks', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + (i % 2 === 0 ? 1 : -1), 180)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ choppinessPeriod: 120, choppinessMax: 0 })
    )
    // falls through to the momentum gate, which rejects the flat series
    assert.isFalse(signal.shouldEnter)
    assert.notMatch(signal.reason!, /choppiness/)
  })
})

test.group('FastStrategy CUSUM trend-break exit', () => {
  test('exits a BUY position when price lingers below its EMA', ({ assert }) => {
    // Rally to 110, then drop to 101 and sit: 300s of (ema - p)/ema
    // accumulation ~1.5% > 1.0% threshold → early regime-break exit.
    const { feed, now } = feedFrom((i) => {
      if (i < 800) return 100 + (110 - 100) * (i / 800)
      return 101
    }, 1100)
    const signal = strategy.evaluateExit(
      feed, 'BTC', 101, now,
      buyPosition({ entryPrice: 100, stopLoss: 95, takeProfit: 150 }),
      baseCfg({ emaPeriod: 100, cusumWindowSeconds: 300, cusumExitPct: 1.0 })
    )
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /cusum trend break/)
  })

  test('does not exit while price rides above its EMA', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.0001, i), 1100)
    const signal = strategy.evaluateExit(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      buyPosition({ entryPrice: 100, stopLoss: 95, takeProfit: 150 }),
      baseCfg({ emaPeriod: 100, cusumWindowSeconds: 300, cusumExitPct: 1.0 })
    )
    assert.isFalse(signal.shouldExit)
  })

  test('disabled (0 threshold) never fires', ({ assert }) => {
    const { feed, now } = feedFrom((i) => {
      if (i < 800) return 100 + (110 - 100) * (i / 800)
      return 101
    }, 1100)
    const signal = strategy.evaluateExit(
      feed, 'BTC', 101, now,
      buyPosition({ entryPrice: 100, stopLoss: 95, takeProfit: 150 }),
      baseCfg({ emaPeriod: 100, cusumWindowSeconds: 300, cusumExitPct: 0 })
    )
    assert.isFalse(signal.shouldExit)
  })
})

test.group('FastStrategy jump-aware stop', () => {
  test('widens the stop after a recent downward jump', ({ assert }) => {
    const t0 = 1_000_000
    const feed = new MomentumFeed()
    for (let i = 0; i < 60; i++) feed.push('BTC', 100, t0 + i * 1000)
    feed.push('BTC', 99, t0 + 60_000) // -1% single-sample jump

    const levels = strategy.entryLevels(
      feed, 'BTC', 100, t0 + 60_000,
      baseCfg({ volatilityWindowSamples: 60, jumpSlackPct: 0.5 }), null
    )
    // SL = 0.5% × 1.005 = 0.5025% → 99.4975; TP unchanged at 1.0%
    assert.closeTo(levels.stopLoss, 99.4975, 1e-9)
    assert.closeTo(levels.takeProfit, 101, 1e-9)
  })

  test('leaves the stop unchanged without a jump', ({ assert }) => {
    const t0 = 1_000_000
    const feed = new MomentumFeed()
    for (let i = 0; i < 61; i++) feed.push('BTC', 100, t0 + i * 1000)
    const levels = strategy.entryLevels(
      feed, 'BTC', 100, t0 + 60_000,
      baseCfg({ volatilityWindowSamples: 60, jumpSlackPct: 0.5 }), null
    )
    assert.closeTo(levels.stopLoss, 99.5, 1e-9)
  })

  test('disabled (slack 0) never widens', ({ assert }) => {
    const t0 = 1_000_000
    const feed = new MomentumFeed()
    for (let i = 0; i < 60; i++) feed.push('BTC', 100, t0 + i * 1000)
    feed.push('BTC', 99, t0 + 60_000)
    const levels = strategy.entryLevels(
      feed, 'BTC', 100, t0 + 60_000,
      baseCfg({ volatilityWindowSamples: 60, jumpSlackPct: 0 }), null
    )
    assert.closeTo(levels.stopLoss, 99.5, 1e-9)
  })
})

test.group('FastStrategy conviction sizing', () => {
  test('disabled returns 1 regardless of signal strength', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, baseCfg())
    assert.isTrue(signal.shouldEnter)
    assert.equal(strategy.convictionMultiplier(signal, baseCfg()), 1)
  })

  test('burst mode: stronger momentum vs threshold → bigger size, capped 1.5', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const cfg = baseCfg({ convictionSizing: true })
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, cfg)
    assert.isTrue(signal.shouldEnter)
    assert.isAbove(signal.momentumPct!, 0.3) // ratio > 3 → capped at 1.5
    assert.equal(strategy.convictionMultiplier(signal, cfg), 1.5)
  })

  test('trend mode: scales with the EMA slope vs threshold', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 3600)
    const cfg = baseCfg({ convictionSizing: true, trendMode: true, emaPeriod: 300, trendSlopePct: 0.05, trendSlopeWindowSeconds: 1800, takeProfitPct: 0 })
    const signal = strategy.evaluateEntry(feed, 'BTC', feed.lastPrice('BTC')!, now, cfg)
    assert.isTrue(signal.shouldEnter)
    assert.isAbove(signal.slopePct!, 0.05) // ratio > 1 → multiplier > 0.75
    const mult = strategy.convictionMultiplier(signal, cfg)
    assert.isAbove(mult, 0.75)
    assert.isAtMost(mult, 1.5)
  })

  test('unmeasurable signal (warming) falls back to 1', ({ assert }) => {
    const signal = {
      shouldEnter: true, reason: 'x', momentumPct: null, rsi: null, ema: null,
      volatilityPct: null, slopePct: null, stopLoss: 99, takeProfit: 101, stopLossPct: 0.5,
    } as unknown as Parameters<typeof strategy.convictionMultiplier>[0]
    assert.equal(strategy.convictionMultiplier(signal, baseCfg({ convictionSizing: true })), 1)
  })
})

test.group('FastStrategy HAR volatility', () => {
  test('harVolForecast flag routes the vol ceiling through the HAR blend', ({ assert }) => {
    // Calm series: HAR ≈ single-window ≈ 0 → ceiling passes either way.
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const signal = strategy.evaluateEntry(
      feed, 'BTC', feed.lastPrice('BTC')!, now,
      baseCfg({ volatilityWindowSamples: 60, volatilityCeilingPct: 1, harVolForecast: true })
    )
    assert.isTrue(signal.shouldEnter)
  })

  test('HAR damps a short-window vol spike via the longer horizons', ({ assert }) => {
    const t0 = 1_000_000
    const feed = new MomentumFeed()
    for (let i = 0; i < 1700; i++) feed.push('BTC', 100, t0 + i * 1000)
    for (let i = 0; i < 300; i++) feed.push('BTC', 100 + (i % 2 === 0 ? 1 : -1), t0 + (1700 + i) * 1000)

    const short = feed.volatilityPct('BTC', 30)!
    const har = feed.harVolatilityPct('BTC', 30, 300, 1800)!
    assert.isAbove(short, 1) // the spike dominates the 30s window
    assert.isBelow(har, short) // long-horizon calm drags the blend down
  })
})

test.group('fastStrategyFromConfig interval scaling', () => {
  const baseRaw = {
    fastMomentumSeconds: 60,
    fastMomentumThresholdPct: 0.1,
    fastRsiLow: 0,
    fastRsiHigh: 1000,
    fastStopLossPct: 0.5,
    fastTakeProfitPct: 1.0,
    fastExitReversalPct: -0.3,
  }

  test('1s default keeps sample counts as seconds', ({ assert }) => {
    const s = fastStrategyFromConfig({ ...baseRaw, fastEmaPeriod: 900, fastVolatilityWindowSeconds: 3600, fastRegimeEmaPeriod: 3600, fastChoppinessPeriod: 600 })
    assert.equal(s.sampleIntervalSeconds, 1)
    assert.equal(s.emaPeriod, 900)
    assert.equal(s.volatilityWindowSamples, 3600)
    assert.equal(s.regimeEmaPeriod, 3600)
    assert.equal(s.choppinessPeriod, 600)
  })

  test('60s bars rescale sample lookbacks, true-time windows pass through', ({ assert }) => {
    const s = fastStrategyFromConfig(
      { ...baseRaw, fastEmaPeriod: 900, fastVolatilityWindowSeconds: 3600, fastRegimeEmaPeriod: 3600, fastChoppinessPeriod: 600, fastMaxHoldSeconds: 7200, fastTrendSlopeWindowSeconds: 1800, fastCusumWindowSeconds: 300 },
      { sampleIntervalSeconds: 60 }
    )
    assert.equal(s.sampleIntervalSeconds, 60)
    assert.equal(s.emaPeriod, 15) // 900s / 60
    assert.equal(s.volatilityWindowSamples, 60)
    assert.equal(s.regimeEmaPeriod, 60)
    assert.equal(s.choppinessPeriod, 10)
    assert.equal(s.momentumSeconds, 60) // time-based: unchanged
    assert.equal(s.maxHoldSeconds, 7200) // true time: unchanged
    assert.equal(s.trendSlopeWindowSeconds, 1800) // true time: unchanged
    assert.equal(s.cusumWindowSeconds, 300) // true time: unchanged
  })

  test('sub-period windows floor at one sample', ({ assert }) => {
    const s = fastStrategyFromConfig({ ...baseRaw, fastEmaPeriod: 30, fastVolatilityWindowSeconds: 20 }, { sampleIntervalSeconds: 60 })
    assert.equal(s.emaPeriod, 1)
    assert.equal(s.volatilityWindowSamples, 1)
  })
})

test.group('FastStrategy vol scaling cadence invariance', () => {
  test('per-minute vol drives identical stops on 1s and 1m feeds', ({ assert }) => {
    const r1s = 0.0003 // 0.03% per-second return
    const r1m = r1s * Math.sqrt(60)

    // 1s feed: 3601 samples with alternating ±r1s returns (σ = r1s) — a
    // full vol window plus the seed return.
    const feed1s = new MomentumFeed()
    let p1s = 100
    for (let i = 0; i <= 3600; i++) {
      p1s *= 1 + (i % 2 === 0 ? r1s : -r1s)
      feed1s.push('BTC', p1s, 1_000_000 + i * 1000)
    }
    // 1m feed: 61 samples with ±√60·r1s returns (σ = √60·r1s).
    const feed1m = new MomentumFeed()
    let p1m = 100
    for (let i = 0; i <= 60; i++) {
      p1m *= 1 + (i % 2 === 0 ? r1m : -r1m)
      feed1m.push('BTC', p1m, 2_000_000 + i * 60_000)
    }

    const mk = (interval: number, windowSamples: number): FastStrategyConfig => ({
      ...baseCfg(),
      sampleIntervalSeconds: interval,
      volatilityWindowSamples: windowSamples,
      volatilityMult: 3,
      volatilityFloorPct: 0, // no floor — we test pure scaling
      volatilityCeilingPct: 0,
      harVolForecast: false,
    })
    const now1s = 1_000_000 + 3600 * 1000
    const now1m = 2_000_000 + 60 * 60_000
    const l1s = strategy.entryLevels(feed1s, 'BTC', 100, now1s, mk(1, 3600), null)
    const l1m = strategy.entryLevels(feed1m, 'BTC', 100, now1m, mk(60, 60), null)

    // Same per-minute vol ⇒ same scaled stop distance, whatever the cadence.
    assert.isAbove(l1s.stopLossPct, 0.5) // scaling engaged (above the base SL)
    assert.closeTo(l1s.stopLossPct, l1m.stopLossPct, 0.001)
    assert.closeTo(l1s.stopLoss, l1m.stopLoss, 0.1)
  })
})

test.group('FastStrategy efficiency-ratio gate', () => {
  test('blocks entries when recent action is chop', ({ assert }) => {
    const feed = new MomentumFeed()
    let p = 100
    // 12 days of alternating whole-day direction — multi-day chop.
    for (let d = 0; d < 12; d++) {
      const drift = d % 2 === 0 ? 1.02 : 1 / 1.02
      for (let i = 0; i < 1440; i++) {
        p *= Math.pow(drift, 1 / 1440)
        feed.push('BTC', p, 1_000_000_000 + (d * 1440 + i) * 60_000)
      }
    }
    const now = 1_000_000_000 + (12 * 1440 - 1) * 60_000
    const cfg = { ...baseCfg(), trendMode: true, emaPeriod: 15, trendSlopePct: 0.1, trendSlopeWindowSeconds: 1800, efficiencyWindowDays: 5, efficiencyMinPct: 40 }
    const sig = strategy.evaluateEntry(feed, 'BTC', p, now, cfg)
    assert.isFalse(sig.shouldEnter)
    assert.match(sig.reason ?? '', /efficiency/)
  })

  test('passes when recent action is directional', ({ assert }) => {
    const feed = new MomentumFeed()
    let p = 100
    for (let i = 0; i < 3 * 1440; i++) {
      p *= 1.0001
      feed.push('BTC', p, 3_000_000_000 + i * 60_000)
    }
    const now = 3_000_000_000 + (3 * 1440 - 1) * 60_000
    const cfg = { ...baseCfg(), trendMode: true, emaPeriod: 15, trendSlopePct: 0.1, trendSlopeWindowSeconds: 1800, efficiencyWindowDays: 1, efficiencyMinPct: 40, stopLossPct: 5, takeProfitPct: 0 }
    const sig = strategy.evaluateEntry(feed, 'BTC', p, now, cfg)
    assert.isTrue(sig.shouldEnter)
  })
})
