import { test } from '@japa/runner'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import {
  FastStrategy,
  FastStrategyConfig,
  fastStrategyFromConfig,
  type JevContext,
} from '../../app/services/FastStrategy.js'

// Jev gate on the pure strategy core (U2): the deterministic signal is
// evaluated first and Jev may only veto entries, shrink size, or annotate
// exits as advisory context. Null, low-confidence, or disabled Jev never
// changes a deterministic outcome. No DB, no WS — synthetic feeds only.

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
    rsiHigh: 1000,
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
    trendMode: false,
    trendSlopePct: 0,
    trendSlopeWindowSeconds: 0,
    regimeEmaPeriod: 0,
    regimeSlopeWindowSeconds: 0,
    regimeSlopeMinPct: 0,
    volumeWindowSamples: 0,
    volumeMinRatio: 0,
    trailingVolatilityMult: 0,
    scaleOutPct: 0,
    harVolForecast: false,
    cusumWindowSeconds: 0,
    cusumExitPct: 0,
    jumpSlackPct: 0,
    choppinessPeriod: 0,
    choppinessMax: 0,
    tradeStartUtc: 0,
    tradeEndUtc: 24,
    convictionSizing: false,
    newsGateEnabled: false,
    newsMinSentiment: 0,
    newsMinArticles: 3,
    newsWindowSeconds: 86400,
    jevGateEnabled: true,
    jevMinConfidence: 0.5,
    jevMinEdgePct: 0.15,
    ...overrides,
  }
}

function trendCfg(overrides: Partial<FastStrategyConfig> = {}): FastStrategyConfig {
  return baseCfg({
    trendMode: true,
    emaPeriod: 300,
    trendSlopePct: 0.05,
    trendSlopeWindowSeconds: 1800,
    takeProfitPct: 0,
    ...overrides,
  })
}

/** Confident bearish Jev read: high P(down), clear edge, high confidence. */
function bearish(overrides: Partial<JevContext> = {}): JevContext {
  return { pUp: 0.2, pDown: 0.72, confidence: 0.8, ...overrides }
}

/** Confident bullish Jev read. */
function bullish(overrides: Partial<JevContext> = {}): JevContext {
  return { pUp: 0.75, pDown: 0.18, confidence: 0.82, ...overrides }
}

function buyPosition(overrides: Record<string, any> = {}) {
  return {
    side: 'BUY' as const,
    entryPrice: 100,
    stopLoss: 99.5,
    takeProfit: 101,
    peakPrice: null,
    openedAt: 1_000_000,
    scaledOut: false,
    ...overrides,
  }
}

test.group('Jev entry veto (burst mode)', () => {
  test('confident-negative vetoes an otherwise warm entry', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const price = feed.lastPrice('BTC')!
    const warm = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg({ jevGateEnabled: false }))
    assert.isTrue(warm.shouldEnter)

    const vetoed = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg(), null, bearish())
    assert.isFalse(vetoed.shouldEnter)
    assert.match(vetoed.reason!, /jev veto/)
    assert.isNull(vetoed.stopLoss)
    assert.isNull(vetoed.takeProfit)
  })

  test('stale context is flagged in the veto reason', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const price = feed.lastPrice('BTC')!
    const vetoed = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg(), null, bearish({ stale: true }))
    assert.isFalse(vetoed.shouldEnter)
    assert.match(vetoed.reason!, /stale/)
  })

  test('low confidence never blocks', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const price = feed.lastPrice('BTC')!
    const signal = strategy.evaluateEntry(
      feed, 'BTC', price, now, baseCfg(), null,
      bearish({ confidence: 0.2 })
    )
    assert.isTrue(signal.shouldEnter)
  })

  test('thin edge never blocks', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const price = feed.lastPrice('BTC')!
    const signal = strategy.evaluateEntry(
      feed, 'BTC', price, now, baseCfg(), null,
      { pUp: 0.45, pDown: 0.5, confidence: 0.9 }
    )
    assert.isTrue(signal.shouldEnter)
  })

  test('null context and disabled gate pass through bit-identical', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 + i * 0.02, 180)
    const price = feed.lastPrice('BTC')!
    const plain = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg({ jevGateEnabled: false }))
    const nulled = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg(), null)
    const disabled = strategy.evaluateEntry(feed, 'BTC', price, now, baseCfg({ jevGateEnabled: false }), null, bearish())
    assert.deepEqual(nulled, plain)
    assert.deepEqual(disabled, plain)
  })
})

test.group('Jev entry veto (trend mode)', () => {
  test('confident-negative vetoes a steady-rally entry', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 3600)
    const price = feed.lastPrice('BTC')!
    const warm = strategy.evaluateEntry(feed, 'BTC', price, now, trendCfg({ jevGateEnabled: false }))
    assert.isTrue(warm.shouldEnter)

    const vetoed = strategy.evaluateEntry(feed, 'BTC', price, now, trendCfg(), null, bearish())
    assert.isFalse(vetoed.shouldEnter)
    assert.match(vetoed.reason!, /jev veto/)
  })

  test('confident-bullish never blocks a warm trend entry', ({ assert }) => {
    const { feed, now } = feedFrom((i) => 100 * Math.pow(1.00001, i), 3600)
    const price = feed.lastPrice('BTC')!
    const signal = strategy.evaluateEntry(feed, 'BTC', price, now, trendCfg(), null, bullish())
    assert.isTrue(signal.shouldEnter)
  })
})

test.group('Jev exit advisory', () => {
  test('stop-loss executes despite a confident hold read, advisory stored', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(feed, 'BTC', 99, now, buyPosition(), baseCfg(), bullish())
    assert.isTrue(signal.shouldExit)
    assert.match(signal.reason!, /stop-loss/)
    assert.isNotNull(signal.jevAdvisory)
    assert.match(signal.jevAdvisory!, /logged only/)
  })

  test('hold path carries the advisory without exiting', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(feed, 'BTC', 100.1, now, buyPosition(), baseCfg(), bearish())
    assert.isFalse(signal.shouldExit)
    assert.isNotNull(signal.jevAdvisory)
  })

  test('no Jev context leaves advisory null and behavior unchanged', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const plain = strategy.evaluateExit(feed, 'BTC', 100.1, now, buyPosition(), baseCfg())
    const nulled = strategy.evaluateExit(feed, 'BTC', 100.1, now, buyPosition(), baseCfg(), null)
    assert.isFalse(plain.shouldExit)
    assert.isNull(plain.jevAdvisory ?? null)
    assert.deepEqual(nulled, plain)
  })

  test('low-confidence read records no advisory', ({ assert }) => {
    const { feed, now } = feedFrom(() => 100, 120)
    const signal = strategy.evaluateExit(feed, 'BTC', 100.1, now, buyPosition(), baseCfg(), bearish({ confidence: 0.1 }))
    assert.isFalse(signal.shouldExit)
    assert.isNull(signal.jevAdvisory ?? null)
  })
})

test.group('Jev shrink-only sizing', () => {
  test('multiplier stays within [0.5, 1] and never grows size', ({ assert }) => {
    const cfg = baseCfg()
    for (const confidence of [0.5, 0.6, 0.8, 0.95, 1.0]) {
      const m = strategy.jevConvictionMultiplier({ pUp: 0.2, pDown: 0.7, confidence }, cfg)
      assert.isTrue(m >= 0.5 && m <= 1.0, `confidence ${confidence} -> ${m}`)
    }
    assert.equal(strategy.jevConvictionMultiplier({ pUp: 0.2, pDown: 0.7, confidence: 1.0 }, cfg), 1.0)
  })

  test('rises monotonically with confidence', ({ assert }) => {
    const cfg = baseCfg()
    const lo = strategy.jevConvictionMultiplier({ pUp: 0.2, pDown: 0.7, confidence: 0.55 }, cfg)
    const hi = strategy.jevConvictionMultiplier({ pUp: 0.2, pDown: 0.7, confidence: 0.9 }, cfg)
    assert.isTrue(hi > lo)
  })

  test('returns 1 when disabled, null, or below floor', ({ assert }) => {
    const cfg = baseCfg()
    assert.equal(strategy.jevConvictionMultiplier(bearish(), baseCfg({ jevGateEnabled: false })), 1)
    assert.equal(strategy.jevConvictionMultiplier(null, cfg), 1)
    assert.equal(strategy.jevConvictionMultiplier(bearish({ confidence: 0.3 }), cfg), 1)
  })
})

test.group('Jev config mapping', () => {
  test('fastJev fields map with documented defaults', ({ assert }) => {
    const mapped = fastStrategyFromConfig({
      fastMomentumSeconds: 60,
      fastMomentumThresholdPct: 0.1,
      fastRsiLow: 0,
      fastRsiHigh: 100,
      fastStopLossPct: 0.5,
      fastTakeProfitPct: 1,
      fastExitReversalPct: -0.3,
      fastNewsGateEnabled: false,
    } as any)
    assert.isFalse(mapped.jevGateEnabled ?? false)
    assert.equal(mapped.jevMinConfidence ?? 0.5, 0.5)
    assert.equal(mapped.jevMinEdgePct ?? 0.15, 0.15)

    const enabled = fastStrategyFromConfig({
      fastMomentumSeconds: 60,
      fastMomentumThresholdPct: 0.1,
      fastRsiLow: 0,
      fastRsiHigh: 100,
      fastStopLossPct: 0.5,
      fastTakeProfitPct: 1,
      fastExitReversalPct: -0.3,
      fastNewsGateEnabled: false,
      fastJevGateEnabled: 1,
      fastJevMinConfidence: 0.7,
      fastJevMinEdgePct: 0.2,
    } as any)
    assert.isTrue(enabled.jevGateEnabled ?? false)
    assert.equal(enabled.jevMinConfidence, 0.7)
    assert.equal(enabled.jevMinEdgePct, 0.2)
  })
})
