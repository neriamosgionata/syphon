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

  test('unsorted input is sorted by time', ({ assert }) => {
    const samples = series((i) => 100 * Math.pow(1.0001, i), 3600)
    samples.reverse()
    const result = engine.run(samples, baseCfg())
    assert.equal(result.trades[0].entryTime, T0 + 60_000) // first decision with a warm 60s feed
  })
})
