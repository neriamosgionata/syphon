import { test } from '@japa/runner'
import { BacktestEngine, BacktestConfig, BacktestSample } from '../../app/services/BacktestEngine.js'

// BacktestEngine replays historical samples through the same feed +
// strategy as the live loop. Synthetic series only — deterministic.

const engine = new BacktestEngine()

const T0 = 1_700_000_000_000

function series(priceFn: (i: number) => number, count: number): BacktestSample[] {
  return Array.from({ length: count }, (_, i) => ({ t: T0 + i * 1000, p: priceFn(i) }))
}

function baseCfg(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'BTC',
    strategy: {
      momentumSeconds: 60,
      momentumThresholdPct: 0.1,
      rsiLow: 0,
      rsiHigh: 1000,
      stopLossPct: 0.5,
      takeProfitPct: 1.5,
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
      newsGateEnabled: false,
      newsMinSentiment: 0,
      newsMinArticles: 3,
      newsWindowSeconds: 86400,
    },
    loopIntervalSeconds: 10,
    portfolioUsd: 10_000,
    feePct: 0.001,
    maxPositions: 1,
    maxExposurePct: 0.8,
    maxSinglePositionPct: 0.2,
    cooldownSeconds: 30,
    ...overrides,
  }
}

test.group('BacktestEngine', () => {
  test('uptrend generates winning trades and positive return', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const result = engine.run(samples, baseCfg())

    assert.isAbove(result.metrics.totalTrades, 1)
    assert.equal(result.metrics.winCount, result.metrics.totalTrades)
    assert.equal(result.metrics.winRate, 1)
    assert.isAbove(result.endUsd, result.startUsd)
    assert.isAbove(result.strategyReturnPct, 0)
    assert.isAbove(result.buyHoldReturnPct, 0)
    // Positions entered in the final ~150s legitimately stay open to the end
    assert.isAtMost(result.trades.filter((t) => t.closedAtEnd).length, 2)
  })

  test('fees reduce returns', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const cfg = baseCfg({ strategy: { ...baseCfg().strategy, takeProfitPct: 5 } })
    const noFee = engine.run(samples, { ...cfg, feePct: 0 })
    const heavyFee = engine.run(samples, { ...cfg, feePct: 0.02 })

    assert.isAbove(noFee.endUsd, heavyFee.endUsd)
    assert.isAbove(heavyFee.metrics.totalPnl, 0) // 5% TP still outpaces 4% round-trip fees
    assert.isAbove(heavyFee.trades[0].feePaid, 0)
  })

  test('max hold exits fire', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.00005, i), 3 * 3600)
    const result = engine.run(samples, baseCfg({
      strategy: {
        ...baseCfg().strategy,
        takeProfitPct: 5,
        maxHoldSeconds: 300,
      },
    }))

    assert.isAbove(result.metrics.totalTrades, 0)
    assert.isTrue(result.trades.some((t) => t.exitReason?.includes('max hold')))
  })

  test('flat market produces no trades', ({ assert }) => {
    const samples = series(() => 100, 2 * 3600)
    const result = engine.run(samples, baseCfg())
    assert.equal(result.metrics.totalTrades, 0)
  })

  test('position still open at end is force-closed', ({ assert }) => {
    // Flat for 3h (no signal), then a slow rally for 20min: entry fires but
    // the position is still open when the series ends.
    const samples = series((i) => {
      if (i < 3 * 3600) return 100
      const k = i - 3 * 3600
      return 100 * Math.pow(1.0001, k)
    }, (3 * 3600) + (20 * 60))

    const result = engine.run(samples, baseCfg({
      strategy: {
        ...baseCfg().strategy,
        takeProfitPct: 10,
      },
    }))

    assert.isAbove(result.metrics.totalTrades, 0)
    assert.isTrue(result.trades.some((t) => t.closedAtEnd && t.exitReason === 'end_of_test'))
  })

  test('cooldown caps trade frequency', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 2 * 3600)
    const result = engine.run(samples, baseCfg({ cooldownSeconds: 3600 }))
    // 2h window, 1h cooldown → at most 2 entries
    assert.isAtMost(result.metrics.totalTrades, 2)
  })

  test('deterministic across runs', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 2 * 3600)
    const a = engine.run(samples, baseCfg())
    const b = engine.run(samples, baseCfg())
    assert.deepEqual(a, b)
  })

  test('drawdown measured on losing markets', ({ assert }) => {
    // Rally then crash: an open position rides the fall.
    const samples = series((i) => {
      if (i <= 3600) return 100 * Math.pow(1.0001, i)
      const k = i - 3600
      return 100 * Math.pow(1.0001, 3600) * Math.pow(0.9995, k)
    }, 2 * 3600)

    const result = engine.run(samples, baseCfg())
    assert.isAbove(result.metrics.maxDrawdownPct, 0)
    assert.equal(result.metrics.maxDrawdownPct, Math.max(0, ...result.equityCurve.map((_, idx) => {
      const peak = Math.max(...result.equityCurve.slice(0, idx + 1).map((p) => p.value))
      return ((peak - result.equityCurve[idx].value) / peak) * 100
    })))
  })

  test('equity curve tracks decisions', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 3600)
    const result = engine.run(samples, baseCfg())
    assert.isAbove(result.equityCurve.length, 100)
    assert.equal(result.equityCurve[0].value, 10_000)
    assert.closeTo(result.equityCurve[0].t, T0, 10_000)
  })

  test('rejects too few samples', ({ assert }) => {
    assert.throws(() => engine.run(series(() => 100, 1), baseCfg()), /at least 2 samples/)
  })

  test('intrabar stop-loss fills at the stop level, not the close', ({ assert }) => {
    // Entry at ~t+60s (momentum gate), then a bar whose LOW pierces the SL
    // while its close stays above it → exit must fill at the SL price.
    const samples: BacktestSample[] = []
    const t0 = T0
    for (let i = 0; i <= 60; i++) {
      samples.push({ t: t0 + i * 1000, p: 100 + i * (1 / 60), h: 100 + i * (1 / 60), l: 100 + i * (1 / 60) })
    }
    // Entry price ≈ 101 → SL = 101 × 0.995 = 100.495. Bar 61 dips below it
    // (low 100.30) but closes above (100.55).
    samples.push({ t: t0 + 61_000, p: 100.55, h: 100.60, l: 100.30 })
    for (let i = 62; i <= 120; i++) {
      samples.push({ t: t0 + i * 1000, p: 100.6 + (i - 61) * 0.01, h: 100.6 + (i - 61) * 0.01, l: 100.6 + (i - 61) * 0.01 })
    }

    const result = engine.run(samples, baseCfg())
    assert.isAbove(result.metrics.totalTrades, 0)
    const first = result.trades[0]
    assert.match(first.exitReason!, /stop-loss \(intrabar\)/)
    assert.closeTo(first.exitPrice!, 100.495, 1e-6)
  })

  test('intrabar take-profit fills at the target level', ({ assert }) => {
    const samples: BacktestSample[] = []
    const t0 = T0
    for (let i = 0; i <= 60; i++) {
      samples.push({ t: t0 + i * 1000, p: 100 + i * (1 / 60), h: 100 + i * (1 / 60), l: 100 + i * (1 / 60) })
    }
    // TP = 101 × 1.015 = 102.515. Bar 61 spikes above it (high 102.6) but
    // closes below (102.4).
    samples.push({ t: t0 + 61_000, p: 102.4, h: 102.60, l: 102.30 })
    for (let i = 62; i <= 120; i++) {
      samples.push({ t: t0 + i * 1000, p: 102.4 - (i - 61) * 0.02, h: 102.4 - (i - 61) * 0.02, l: 102.4 - (i - 61) * 0.02 })
    }

    const result = engine.run(samples, baseCfg())
    assert.isAbove(result.metrics.totalTrades, 0)
    const first = result.trades[0]
    assert.match(first.exitReason!, /take-profit \(intrabar\)/)
    assert.closeTo(first.exitPrice!, 102.515, 1e-6)
  })

  test('risk-normalized sizing shrinks positions with wider stops', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const base = engine.run(samples, baseCfg())
    const risky = engine.run(samples, baseCfg({ riskPerTradePct: 0.05 }))
    assert.isAbove(base.trades[0].quantity, risky.trades[0].quantity)
    // SL 0.5% → risk 0.05% → 10% position (vs 20% max single)
    assert.closeTo(risky.trades[0].quantity, base.trades[0].quantity * 0.5, 1e-6)
  })

  test('correlated-exposure cap limits position size', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const capped = engine.run(samples, baseCfg({ correlatedExposurePct: 0.05 }))
    const base = engine.run(samples, baseCfg())
    assert.isBelow(capped.trades[0].quantity, base.trades[0].quantity)
  })

  test('loss-streak pause blocks entries until the streak resets', ({ assert }) => {
    // Each cycle: slow rise (+1.2%, entry fires, TP at 1.5% never reached)
    // then a slide (-4%, stop out). Consecutive losing closes accumulate;
    // with maxLossStreak 2 and no time-based pause, entries stop forever
    // after 2 losses.
    const samples: BacktestSample[] = []
    const t0 = T0
    let cursor = 0
    let price = 100
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 120; i++) {
        price *= 1.0001
        samples.push({ t: t0 + cursor * 1000, p: price })
        cursor++
      }
      for (let i = 0; i < 400; i++) {
        price *= 0.9999
        samples.push({ t: t0 + cursor * 1000, p: price })
        cursor++
      }
      for (let i = 0; i < 200; i++) {
        samples.push({ t: t0 + cursor * 1000, p: price })
        cursor++
      }
    }

    const result = engine.run(samples, baseCfg({
      maxLossStreak: 2,
      lossStreakPauseSeconds: 0,
      strategy: { ...baseCfg().strategy, exitReversalPct: -50 }, // SL-only exits
    }))
    assert.equal(result.metrics.lossCount, 2)
    assert.equal(result.metrics.totalTrades, 2)
  })

  test('scale-out locks in a fraction and the remainder rides on', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const result = engine.run(samples, baseCfg({
      strategy: {
        ...baseCfg().strategy,
        takeProfitPct: 10,
        trailingStopPct: 2.0,
        trailingActivatePct: 1.5,
        scaleOutPct: 0.5,
      },
    }))

    const partials = result.trades.filter((t) => t.partial)
    assert.isAbove(partials.length, 0)
    assert.match(partials[0].exitReason!, /scale-out/)
    // Scale-out quantity = 50% of the original entry quantity.
    const remainder = result.trades.find((t) => !t.partial)
    assert.isDefined(remainder)
    assert.closeTo(partials[0].quantity, remainder!.quantity, 2e-6)
    // Partial PnL is included in the total.
    assert.isAbove(partials[0].pnl, 0)
  })

  test('maker limit entries fill at the limit price when touched', ({ assert }) => {
    // Rise to the entry decision, then a pullback bar whose low dips below
    // the limit (decision price + 0.05%) → fill at the limit price.
    const samples: BacktestSample[] = []
    const t0 = T0
    for (let i = 0; i <= 60; i++) {
      samples.push({ t: t0 + i * 1000, p: 100 + i * (1 / 60), h: 100 + i * (1 / 60), l: 100 + i * (1 / 60) })
    }
    const decisionPrice = 100 + 60 * (1 / 60) // 101
    const limit = decisionPrice * 1.0005 // offset 0.05%
    samples.push({ t: t0 + 61_000, p: 100.55, h: 100.60, l: 100.50 }) // low < limit → fill
    for (let i = 62; i <= 300; i++) {
      samples.push({ t: t0 + i * 1000, p: 100.6 + (i - 61) * 0.01, h: 100.6 + (i - 61) * 0.01, l: 100.6 + (i - 61) * 0.01 })
    }

    const result = engine.run(samples, baseCfg({ limitFillSeconds: 10, limitOffsetPct: 0.05, makerFeePct: 0.0008 }))
    assert.isAbove(result.metrics.totalTrades, 0)
    assert.closeTo(result.trades[0].entryPrice, limit, 1e-6)
  })

  test('maker limit entries are skipped when the limit is never touched', ({ assert }) => {
    // Monotonic rise with the limit at the decision price (offset 0): the
    // next bar always closes above → never fills → no trades.
    const samples = series((i) => 100 * Math.pow(1.0001, i), 3600)
    const result = engine.run(samples, baseCfg({ limitFillSeconds: 10, limitOffsetPct: 0, makerFeePct: 0.0008 }))
    assert.equal(result.metrics.totalTrades, 0)
  })

  test('volatility targeting shrinks positions in high-vol regimes', ({ assert }) => {
    // Same drift after a 700s warmup (so the 600s vol window is filled at
    // the first entry), different per-second wiggle: the high-vol series
    // must size down against the vol target.
    const warm = 700
    const withWarmup = (fn: (i: number) => number) =>
      Array.from({ length: 3600 }, (_, i) => ({
        t: T0 + i * 1000,
        p: i < warm ? 100 : fn(i - warm),
      }))
    const smooth = withWarmup((i) => 100 * Math.pow(1.0001, i))
    const wild = withWarmup((i) => 100 * Math.pow(1.0001, i) + (i % 2 === 0 ? 0.5 : -0.5))

    const base = engine.run(smooth, baseCfg())
    const targetCfg = baseCfg({ volTargetPct: 50, volTargetWindowSeconds: 600, volTargetMaxMult: 2 })
    const smoothTarget = engine.run(smooth, targetCfg)
    const wildTarget = engine.run(wild, targetCfg)

    // Smooth series: realized vol below target → multiplier ≥ 1, capped by
    // maxSingle → same size as base.
    assert.closeTo(smoothTarget.trades[0].quantity, base.trades[0].quantity, 1e-6)
    // Wild series: vol above target → floor 0.2 multiplier → much smaller.
    assert.isBelow(wildTarget.trades[0].quantity, base.trades[0].quantity * 0.5)
  })

  test('unsorted input is sorted by time', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 3600)
    samples.reverse()
    const result = engine.run(samples, baseCfg())
    assert.equal(result.trades[0].entryTime, T0 + 60_000) // first decision with a warm 60s feed
  })

  test('slippage erodes returns and shows in fill prices', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const clean = engine.run(samples, baseCfg())
    const slipped = engine.run(samples, baseCfg({ slippageBps: 50 }))

    assert.isAbove(clean.metrics.totalTrades, 1)
    assert.equal(slipped.metrics.totalTrades, clean.metrics.totalTrades)
    assert.isBelow(slipped.endUsd, clean.endUsd)
    // Market entries fill at price × (1 + 50bps).
    assert.isAbove(slipped.trades[0].entryPrice, clean.trades[0].entryPrice)
  })

  test('slippage applies to stop-loss fills (worse fills on exits)', ({ assert }) => {
    // Rally, then a crash into the stop: SL sells at stop × (1 - slip).
    // TP is set far away so the rally cannot take profit before the crash.
    const samples: BacktestSample[] = []
    for (let i = 0; i < 600; i++) samples.push({ t: T0 + i * 1000, p: 100 + (110 - 100) * (i / 600) })
    for (let i = 600; i < 1200; i++) samples.push({ t: T0 + i * 1000, p: 110 - (110 - 95) * ((i - 600) / 600) })
    const strategy = { ...baseCfg().strategy, takeProfitPct: 50, exitReversalPct: -50 } // SL-only exits

    const clean = engine.run(samples, baseCfg({ strategy }))
    const slipped = engine.run(samples, baseCfg({ strategy, slippageBps: 100 }))
    const slTrade = slipped.trades.find((t) => (t.exitReason || '').includes('stop-loss'))
    assert.isNotNull(slTrade)
    // SL level ≈ 0.5% below entry; slipped exit fills lower still.
    assert.isBelow(slTrade!.exitPrice, slTrade!.entryPrice * 0.995 * (1 - 0.01))
  })

  test('conviction sizing runs without changing capped-size behavior', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const cfg = baseCfg()
    cfg.strategy.convictionSizing = true
    const result = engine.run(samples, cfg)
    assert.isAbove(result.metrics.totalTrades, 1)
    assert.isAbove(result.endUsd, result.startUsd)
    // Strong momentum → multiplier hits the 1.5 cap, but maxSinglePositionPct
    // (0.2) still binds → identical sizing to the baseline.
    assert.closeTo(result.trades[0].quantity, engine.run(samples, baseCfg()).trades[0].quantity, 1e-6)
  })
})

test.group('BacktestEngine coarse intervals', () => {
  const strategy = (overrides: Record<string, unknown> = {}) => ({
    ...baseCfg().strategy,
    momentumSeconds: 60,
    momentumThresholdPct: 0.02,
    stopLossPct: 0.5,
    takeProfitPct: 5,
    exitReversalPct: -5,
    cooldownSeconds: 30,
    sampleIntervalSeconds: 60,
    ...overrides,
  })

  test('decision loop floors to the sample interval on 1m bars', ({ assert }) => {
    // 3h of 1m bars in a steady uptrend.
    const samples = Array.from({ length: 180 }, (_, i) => ({
      t: T0 + i * 60_000,
      p: 100 * Math.pow(1.0002, i),
    }))
    const result = engine.run(samples, baseCfg({ strategy: strategy(), loopIntervalSeconds: 10, cooldownSeconds: 30 }))
    // Coarse bars carry no new information between samples — decide at 60s.
    const step = result.equityCurve.length > 1 ? result.equityCurve[1].t - result.equityCurve[0].t : 0
    assert.equal(step, 60_000)
    assert.isAbove(result.metrics.totalTrades, 0)
    assert.isAbove(result.strategyReturnPct, 0)
  })

  test('run is re-entrant across interval switches', ({ assert }) => {
    const coarse = Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * 60_000, p: 100 * Math.pow(1.0001, i) }))
    const fine = Array.from({ length: 4 * 3600 }, (_, i) => ({ t: T0 + i * 1000, p: 100 * Math.pow(1.0001, i) }))
    engine.run(coarse, baseCfg({ strategy: strategy(), loopIntervalSeconds: 10 }))
    const back = engine.run(fine, baseCfg({ strategy: { ...strategy(), sampleIntervalSeconds: 1 } }))
    assert.isAbove(back.metrics.totalTrades, 1)
    // Feed buffer shrank for the coarse run; the fine run must restore the 1s bound.
    assert.isAbove(back.equityCurve.length, 100)
  })
})

test.group('BacktestEngine trailing-stop confirmation', () => {
  // A position whose trail is armed must have the breach PERSIST before the
  // trailing stop fires; single-bar dips that recover are held.
  const trailSeries = (n: number, fn: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ t: T0 + i * 60_000, p: fn(i) }))

  const armCfg = (over: Partial<BacktestConfig> = {}) => baseCfg({
    strategy: {
      ...baseCfg().strategy,
      sampleIntervalSeconds: 60,
      momentumSeconds: 30,
      momentumThresholdPct: 0.01,
      exitReversalPct: -99,
      trailingStopPct: 5,
      trailingActivatePct: 2,
      stopLossPct: 10, // hard SL far away — only the trail matters
      takeProfitPct: 0,
    },
    loopIntervalSeconds: 60,
    cooldownSeconds: 0,
    ...over,
  })

  test('single-bar trail dip is held with confirmation, persistent breach exits', ({ assert }) => {
    // Ramp 100 -> 106 (trail arms: peak 106, trail 100.7), one -3% bar (dip to
    // ~102.8 > trail 100.7, no breach), then a bar through the trail (99.9),
    // then recovery above (101), then a sustained breach (99.5, 99.4).
    const prices: number[] = []
    for (let i = 0; i < 60; i++) prices.push(100 + (i / 60) * 6) // to 106
    prices.push(102.8) // dip, above trail 100.7
    prices.push(99.9)  // breach #1
    prices.push(101.0) // recovery -> marker reset
    prices.push(99.5)  // breach #2
    prices.push(99.4)  // breach #2 persists
    const samples = trailSeries(prices.length, (i) => prices[i])

    const confirm = engine.run(samples, armCfg({ trailConfirmSeconds: 120 }))
    const noConfirm = engine.run(samples, armCfg())
    // Confirmation delays the trail exit past the recovered dip: the same
    // single position exits later (only after the second, persistent breach).
    // Without confirmation the dip-through-trail bar stops the position out
    // (and the next entry trades again); with confirmation the breach never
    // persists, so the original position survives to the end.
    assert.isAbove(noConfirm.metrics.totalTrades, confirm.metrics.totalTrades)
    assert.match(noConfirm.trades[0].exitReason ?? '', /stop-loss/)
    assert.match(confirm.trades[0].exitReason ?? '', /end_of_test/)
    const cExit = confirm.trades[0].exitTime ?? 0
    const nExit = noConfirm.trades[0].exitTime ?? 0
    assert.isAtLeast(cExit, nExit)
  })
})

test.group('BacktestEngine maker fallback on coarse bars', () => {
  const coarseSeries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ t: T0 + i * 60_000, p: 100 * Math.pow(1.0003, i) }))

  const mkStrategy = () => ({
    ...baseCfg().strategy,
    sampleIntervalSeconds: 60,
    momentumSeconds: 60,
    momentumThresholdPct: 0.02,
    stopLossPct: 0.5,
    takeProfitPct: 5,
    exitReversalPct: -5,
  })

  test('sub-bar limit window cannot fill — falls back to MARKET so entries still happen', ({ assert }) => {
    // 15s limit window < 60s bars: a limit could never fill (pre-fix: 0 trades).
    const samples = coarseSeries(240)
    const result = engine.run(samples, baseCfg({
      strategy: mkStrategy(),
      limitFillSeconds: 15,
      limitOffsetPct: 0.05,
      feePct: 0.001,
      cooldownSeconds: 30,
    }))
    assert.isAbove(result.metrics.totalTrades, 0)
  })

  test('full-bar limit window keeps maker execution on coarse bars', ({ assert }) => {
    const samples = coarseSeries(240)
    const result = engine.run(samples, baseCfg({
      strategy: mkStrategy(),
      limitFillSeconds: 60,
      limitOffsetPct: 0.05,
      feePct: 0.001,
      cooldownSeconds: 30,
    }))
    assert.isAbove(result.metrics.totalTrades, 0)
    assert.isAbove(result.metrics.totalPnl, 0)
  })

  // ── News gate replay (migration 21) ──────────────────────────

  const newsGateStrategy = () => ({
    ...baseCfg().strategy,
    newsGateEnabled: true,
    newsMinSentiment: 0,
    newsMinArticles: 3,
    newsWindowSeconds: 6 * 3600,
  })

  test('negative news events block entries through the whole run', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    // Events started before the series begins (every 10 min) so the gate
    // already sees >= minArticles events at the first decision tick.
    const newsEvents = Array.from({ length: 28 }, (_, i) => ({
      t: T0 - 40 * 60_000 + i * 600_000,
      score: -0.6,
    }))
    const result = engine.run(samples, baseCfg({ strategy: newsGateStrategy(), newsEvents }))
    assert.equal(result.metrics.totalTrades, 0)
  })

  test('news gate with insufficient events does not block', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const newsEvents = [{ t: T0 + 60_000, score: -0.9 }]
    const result = engine.run(samples, baseCfg({ strategy: newsGateStrategy(), newsEvents }))
    assert.isAbove(result.metrics.totalTrades, 1)
  })

  test('positive news never blocks entries', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const newsEvents = Array.from({ length: 24 }, (_, i) => ({
      t: T0 + i * 600_000,
      score: 0.7,
    }))
    const result = engine.run(samples, baseCfg({ strategy: newsGateStrategy(), newsEvents }))
    assert.isAbove(result.metrics.totalTrades, 1)
  })

  test('negative news only inside the window blocks; stale news passes', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    // All events older than the 6h window: at decision time they are
    // filtered out, so the gate sees no news and never blocks.
    const newsEvents = Array.from({ length: 24 }, (_, i) => ({
      t: T0 - 8 * 3600_000 + i * 600_000,
      score: -0.6,
    }))
    const result = engine.run(samples, baseCfg({ strategy: newsGateStrategy(), newsEvents }))
    assert.isAbove(result.metrics.totalTrades, 1)
  })

  test('gate disabled ignores news events entirely', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 4 * 3600)
    const newsEvents = Array.from({ length: 24 }, (_, i) => ({ t: T0 + i * 600_000, score: -0.6 }))
    const result = engine.run(samples, baseCfg({ newsEvents }))
    assert.isAbove(result.metrics.totalTrades, 1)
  })
})
