import { test } from '@japa/runner'
import TrendConfig from '../../app/models/TrendConfig.js'
import TrendEvaluation from '../../app/models/TrendEvaluation.js'
import { filterRecentSamples, resampleSamples } from '../../app/utils/bar_resample.js'
import {
  greenMonthCount,
  sliceEquityCurve,
  trailingNegativeMonthStreak,
} from '../../app/services/trend_metrics.js'
import {
  CERTIFICATION_MIN_BARS,
  FROZEN_TREND_ENGINE,
  FROZEN_TREND_STRATEGY,
  certifyTrend,
  ensureFrozenTrendConfig,
  reportLines,
  strategyConfigFromTrendConfig,
  trendConfigHash,
} from '../../app/services/trend_config.js'
import type { BacktestSample } from '../../app/services/BacktestEngine.js'

// Trend certification: 1m→5m resampling, the frozen-config mapper in
// sample units, lookback refusal, stored-snapshot evidence, provenance
// labels, and hand-checked monthly slices.

const MINUTE_MS = 60_000
const BAR_MS = 300_000

function synthetic(count: number, start = Date.UTC(2026, 0, 1)): BacktestSample[] {
  const out: BacktestSample[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    price = price * (1 + Math.sin(i / 100) * 0.002)
    out.push({ t: start + i * BAR_MS, p: price, h: price * 1.001, l: price * 0.999, v: 10 })
  }
  return out
}

test.group('bar resampling', () => {
  test('aggregates 1m samples to 5m OHLCV and preserves gaps', ({ assert }) => {
    const base = Date.UTC(2026, 0, 1)
    const samples: BacktestSample[] = [
      { t: base, p: 100, h: 101, l: 99.5, v: 1 },
      { t: base + MINUTE_MS, p: 100.5, h: 102, l: 100, v: 2 },
      { t: base + 2 * MINUTE_MS, p: 101, h: 101.5, l: 100.5, v: 3 },
      // minutes 3 and 4 are missing (bucket gap)
      { t: base + BAR_MS, p: 90, h: 91, l: 89, v: 4 },
      { t: base + BAR_MS + MINUTE_MS, p: 92, h: 93, l: 90.5, v: 5 },
    ]

    const bars = resampleSamples(samples, 60, 300)

    assert.lengthOf(bars, 2)
    assert.equal(bars[0].t, base)
    assert.closeTo(bars[0].p, 101, 1e-9)
    assert.closeTo(bars[0].h!, 102, 1e-9)
    assert.closeTo(bars[0].l!, 99.5, 1e-9)
    assert.closeTo(bars[0].v!, 6, 1e-9)

    assert.equal(bars[1].t, base + BAR_MS)
    assert.closeTo(bars[1].p, 92, 1e-9)
    assert.closeTo(bars[1].h!, 93, 1e-9)
    assert.closeTo(bars[1].l!, 89, 1e-9)
    assert.closeTo(bars[1].v!, 9, 1e-9)
  })

  test('rejects invalid target cadences', ({ assert }) => {
    assert.throws(() => resampleSamples([], 300, 60))
    assert.throws(() => resampleSamples([], 60, 90))
  })

  test('windows samples to the trailing hours', ({ assert }) => {
    const now = Date.UTC(2026, 0, 10)
    const samples: BacktestSample[] = [
      { t: now - 72 * 3600_000, p: 1 },
      { t: now - 24 * 3600_000, p: 2 },
      { t: now, p: 3 },
    ]
    assert.lengthOf(filterRecentSamples(samples, 0), 3)
    assert.lengthOf(filterRecentSamples(samples, 48, now), 2)
    assert.deepEqual(filterRecentSamples(samples, 48, now).map((s) => s.p), [2, 3])
  })
})

test.group('trend config mapping', (group) => {
  group.each.setup(async () => {
    await TrendEvaluation.query().delete()
    await TrendConfig.query().delete()
  })

  test('the frozen row maps to sample units without rescaling', async ({ assert }) => {
    const row = await ensureFrozenTrendConfig()
    const strategy = strategyConfigFromTrendConfig(row)

    assert.equal(strategy.emaPeriod, 288)
    assert.equal(strategy.regimeEmaPeriod, 1152)
    assert.equal(strategy.efficiencyWindowDays, 14)
    assert.equal(strategy.efficiencyMinPct, 40)
    assert.equal(strategy.takeProfitPct, 0)
    assert.equal(strategy.trailingStopPct, 12)
    assert.equal(strategy.trailingActivatePct, 6)
    assert.equal(strategy.trendMode, true)
    // Regression: routing through fastStrategyFromConfig would turn 288 into 1.
    assert.notEqual(strategy.emaPeriod, 1)

    // Idempotent single row.
    await ensureFrozenTrendConfig()
    assert.lengthOf(await TrendConfig.all(), 1)
  })

  test('extras may extend the config but the cadence stays pinned', async ({ assert }) => {
    const row = await ensureFrozenTrendConfig()
    row.extras = { strategy: { momentumSeconds: 42, sampleIntervalSeconds: 1 } }
    await row.save()

    const strategy = strategyConfigFromTrendConfig(row)
    assert.equal(strategy.momentumSeconds, 42)
    assert.equal(strategy.sampleIntervalSeconds, 300)
  })

  test('the config hash is order-independent and value-sensitive', ({ assert }) => {
    const engine = FROZEN_TREND_ENGINE
    const a = trendConfigHash(FROZEN_TREND_STRATEGY, engine)
    const reordered = JSON.parse(JSON.stringify(FROZEN_TREND_STRATEGY))
    assert.equal(trendConfigHash(reordered, engine), a)

    const changed = { ...FROZEN_TREND_STRATEGY, emaPeriod: 1 }
    assert.notEqual(trendConfigHash(changed, engine), a)
  })
})

test.group('trend certification', (group) => {
  group.each.setup(async () => {
    await TrendEvaluation.query().delete()
    await TrendConfig.query().delete()
  })

  test('refuses a window shorter than the longest lookback', async ({ assert }) => {
    const outcome = await certifyTrend({
      symbol: 'BTC',
      samples: synthetic(1000),
      provenance: 'bar_records',
      sourceLabel: 'bar_records test',
    })

    assert.isFalse(outcome.certified)
    assert.match(outcome.reason!, new RegExp(String(CERTIFICATION_MIN_BARS)))
    assert.lengthOf(await TrendEvaluation.all(), 0)
  })

  test('certifies a sufficient window and records the evidence', async ({ assert }) => {
    const outcome = await certifyTrend({
      symbol: 'BTC',
      samples: synthetic(CERTIFICATION_MIN_BARS + 100),
      provenance: 'bar_records',
      sourceLabel: 'bar_records BTC 300s/4400h',
    })

    assert.isTrue(outcome.certified)
    const evaluation = await TrendEvaluation.firstOrFail()
    assert.equal(evaluation.state, 'certified')
    assert.isFalse(evaluation.provisional)
    assert.equal((evaluation.configHash ?? '').length, 64)
    assert.equal(evaluation.configSnapshot!.strategy.emaPeriod, 288)
    assert.equal(evaluation.configSnapshot!.provenance, 'bar_records')
    assert.isArray(evaluation.monthly)
    assert.isArray(evaluation.quarterly)

    // Editing the live config row afterwards cannot rewrite the snapshot.
    const row = await TrendConfig.query().where('name', 'frozen').firstOrFail()
    row.emaPeriod = 1
    await row.save()

    const stored = await TrendEvaluation.firstOrFail()
    assert.equal(stored.configSnapshot!.strategy.emaPeriod, 288)
    assert.notInclude(reportLines([stored]).join('\n'), 'research-only')
  })

  test('research-cache provenance is labeled research-only', async ({ assert }) => {
    const outcome = await certifyTrend({
      symbol: 'BTC',
      samples: synthetic(CERTIFICATION_MIN_BARS + 100),
      provenance: 'research',
      sourceLabel: 'Binance 1m research cache resampled to 5m',
    })

    assert.isTrue(outcome.certified)
    const evaluation = await TrendEvaluation.firstOrFail()
    assert.equal(evaluation.state, 'research')
    assert.isTrue(evaluation.provisional)
    assert.isTrue(evaluation.configSnapshot!.researchOnly)
    assert.isTrue(evaluation.configSnapshot!.provenance === 'research')

    const lines = reportLines([evaluation]).join('\n')
    assert.include(lines, 'research-only')
    assert.include(lines, 'not Kraken-gated')
  })
})

test.group('trend metric slices', () => {
  test('hand-checked monthly and quarterly returns', ({ assert }) => {
    const curve = [
      { t: Date.UTC(2026, 0, 15), value: 100 },
      { t: Date.UTC(2026, 0, 31), value: 110 },
      { t: Date.UTC(2026, 1, 15), value: 105 },
      { t: Date.UTC(2026, 1, 28), value: 94.5 },
      { t: Date.UTC(2026, 2, 31), value: 118.125 },
    ]

    const monthly = sliceEquityCurve(curve, 'month')
    assert.deepEqual(
      monthly.map((slice) => slice.period),
      ['2026-01', '2026-02', '2026-03']
    )
    assert.closeTo(monthly[0].returnPct, 10, 1e-9)
    assert.closeTo(monthly[1].returnPct, ((94.5 / 110) - 1) * 100, 1e-9)
    assert.closeTo(monthly[2].returnPct, ((118.125 / 94.5) - 1) * 100, 1e-9)

    assert.equal(greenMonthCount(monthly), 2)
    assert.equal(trailingNegativeMonthStreak(monthly), 0)

    const quarterly = sliceEquityCurve(curve, 'quarter')
    assert.lengthOf(quarterly, 1)
    assert.closeTo(quarterly[0].returnPct, ((118.125 / 100) - 1) * 100, 1e-9)
  })

  test('counts a trailing negative-month streak for the tripwire', ({ assert }) => {
    const curve = [
      { t: Date.UTC(2026, 0, 15), value: 100 },
      { t: Date.UTC(2026, 0, 31), value: 110 },
      { t: Date.UTC(2026, 1, 15), value: 104.5 },
      { t: Date.UTC(2026, 1, 28), value: 95 },
      { t: Date.UTC(2026, 2, 31), value: 85 },
    ]

    const monthly = sliceEquityCurve(curve, 'month')
    assert.equal(trailingNegativeMonthStreak(monthly), 2)
  })
})
