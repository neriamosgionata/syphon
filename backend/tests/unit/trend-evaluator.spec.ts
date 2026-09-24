import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import { TrendEvalService, TREND_TRIP_CONTROL_NAME } from '../../app/services/TrendEvalService.js'
import { evaluateTripwires } from '../../app/services/Tripwire.js'
import TrendConfig from '../../app/models/TrendConfig.js'
import TrendEvaluation from '../../app/models/TrendEvaluation.js'
import OperationAlert from '../../app/models/OperationAlert.js'
import ControlRecord from '../../app/models/ControlRecord.js'
import { FROZEN_LOOKBACK_SAMPLES, ensureFrozenTrendConfig } from '../../app/services/trend_config.js'
import type { BacktestResult, BacktestSample } from '../../app/services/BacktestEngine.js'
import type { BarCoverage } from '../../app/services/BarRecorderService.js'

// Trend paper evaluator: deterministic replay, provisional gating, latching
// tripwires with reasoned resume, stalled-store handling, and the absence of
// any order path (asserted on the module sources).

const BASE_NOW = Date.UTC(2026, 6, 1)
const BAR_MS = 300_000
const LOOKBACK = FROZEN_LOOKBACK_SAMPLES

function samplesOf(count: number): BacktestSample[] {
  const start = BASE_NOW - count * BAR_MS
  const out: BacktestSample[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    price = price * (1 + Math.sin(i / 60) * 0.003)
    out.push({ t: start + i * BAR_MS, p: price, h: price * 1.001, l: price * 0.999, v: 10 })
  }
  return out
}

function coverage(overrides: Partial<BarCoverage> = {}): BarCoverage {
  return {
    symbol: 'BTC',
    intervalSeconds: 300,
    oldest: BASE_NOW - LOOKBACK * BAR_MS,
    newest: BASE_NOW - BAR_MS,
    bars: LOOKBACK,
    gaps: [],
    unrecoverableGaps: 0,
    staleMs: BAR_MS,
    lastError: null,
    healthy: true,
    ...overrides,
  }
}

function curve(...points: Array<[number, number]>): Array<{ t: number; value: number }> {
  return points.map(([t, value]) => ({ t, value }))
}

function replayResult(
  symbol: string,
  samples: BacktestSample[],
  overrides: { drawdown: number; equityCurve: Array<{ t: number; value: number }>; trades?: number }
): BacktestResult {
  return {
    symbol,
    samples: samples.length,
    startTime: samples.length ? samples[0].t : BASE_NOW,
    endTime: samples.length ? samples[samples.length - 1].t : BASE_NOW,
    startUsd: 10_000,
    endUsd: 11_000,
    strategyReturnPct: 10,
    buyHoldReturnPct: 5,
    metrics: {
      totalTrades: overrides.trades ?? 4,
      winCount: 3,
      lossCount: 1,
      winRate: 0.75,
      totalPnl: 1000,
      avgPnlPct: 5,
      largestWin: 900,
      largestLoss: -100,
      profitFactor: 1.8,
      avgHoldingSeconds: 3600,
      maxDrawdownPct: overrides.drawdown,
    },
    trades: [],
    equityCurve: overrides.equityCurve,
  }
}

function makeService(overrides: Record<string, any> = {}) {
  return new TrendEvalService({
    symbols: ['BTC'],
    now: () => BASE_NOW,
    configRow: () => ensureFrozenTrendConfig(),
    coverage: async () => coverage(),
    loadSamples: async () => samplesOf(LOOKBACK + 50),
    runReplay: (symbol, samples, cfg) =>
      replayResult(symbol, samples, {
        drawdown: 5,
        equityCurve: curve(
          [Date.UTC(2026, 0, 15), 10000],
          [Date.UTC(2026, 0, 31), 11000],
          [Date.UTC(2026, 1, 28), 10500],
          [Date.UTC(2026, 2, 31), 11500]
        ),
      }),
    lookbackSamples: LOOKBACK,
    lockTtlMs: 60_000,
    ...overrides,
  })
}

test.group('TrendEvalService', (group) => {
  group.each.setup(async () => {
    await TrendEvaluation.query().delete()
    await TrendConfig.query().delete()
    await OperationAlert.query().delete()
    await ControlRecord.query().delete()
  })

  test('replaying a fixed bar set twice yields byte-identical metrics', async ({ assert }) => {
    const service = new TrendEvalService({
      symbols: ['BTC'],
      now: () => BASE_NOW,
      configRow: () => ensureFrozenTrendConfig(),
      lookbackSamples: LOOKBACK,
    })
    const samples = samplesOf(LOOKBACK + 50)

    const first = await service.evaluateSamples('BTC', samples)
    const second = await service.evaluateSamples('BTC', samples)

    assert.equal(second.state, 'paper')
    assert.equal(second.netReturnPct, first.netReturnPct)
    assert.equal(second.maxDrawdownPct, first.maxDrawdownPct)
    assert.equal(second.tradeCount, first.tradeCount)
    assert.equal(second.profitFactor, first.profitFactor)
    assert.equal(second.greenMonths, first.greenMonths)
    assert.deepEqual(second.monthly, first.monthly)
    assert.deepEqual(second.quarterly, first.quarterly)
  })

  test('monthly slices and green months match the hand-computed fixture', async ({ assert }) => {
    const service = makeService()
    const evaluation = await service.evaluateSamples('BTC', samplesOf(LOOKBACK + 50))

    assert.equal(evaluation.state, 'paper')
    assert.isFalse(evaluation.provisional)
    assert.equal(evaluation.greenMonths, 2)
    assert.deepEqual(
      (evaluation.monthly ?? []).map((slice: any) => slice.period),
      ['2026-01', '2026-02', '2026-03']
    )
    assert.closeTo(evaluation.monthly![1].returnPct, ((10500 / 11000) - 1) * 100, 1e-9)
    const trips = (await OperationAlert.all()).filter((alert) => alert.code === 'tripwire')
    assert.lengthOf(trips, 0)
  })

  test('a short series is provisional and cannot trip a tripwire', async ({ assert }) => {
    const service = makeService({
      runReplay: (symbol: string, samples: BacktestSample[]) =>
        replayResult(symbol, samples, {
          drawdown: 40,
          equityCurve: curve([Date.UTC(2026, 0, 15), 10000], [Date.UTC(2026, 1, 28), 6000]),
        }),
    })

    const evaluation = await service.evaluateSamples('BTC', samplesOf(LOOKBACK - 100))

    assert.equal(evaluation.state, 'provisional')
    assert.isTrue(evaluation.provisional)
    assert.isNull(evaluation.monthly)
    assert.isNull(evaluation.greenMonths)
    assert.isNull(await ControlRecord.get(TREND_TRIP_CONTROL_NAME))
    const trips = (await OperationAlert.all()).filter((alert) => alert.code === 'tripwire')
    assert.lengthOf(trips, 0)
  })

  test('a gapped window is provisional and excluded from certification', async ({ assert }) => {
    const service = makeService()
    const evaluation = await service.evaluateSamples('BTC', samplesOf(LOOKBACK + 50), { coverageGap: true })

    assert.equal(evaluation.state, 'provisional')
    assert.isTrue(evaluation.provisional)
    assert.isFalse(evaluation.coverageOk)
    assert.isNull(evaluation.monthly)
  })

  test('two consecutive negative months latch the tripwire until a reasoned resume', async ({ assert }) => {
    const negativeCurve = curve(
      [Date.UTC(2026, 0, 31), 10000],
      [Date.UTC(2026, 1, 28), 9500],
      [Date.UTC(2026, 2, 31), 9000]
    )
    const service = makeService({
      runReplay: (symbol: string, samples: BacktestSample[]) =>
        replayResult(symbol, samples, { drawdown: 5, equityCurve: negativeCurve }),
    })

    await service.evaluateSamples('BTC', samplesOf(LOOKBACK + 50))

    const trip = await ControlRecord.get(TREND_TRIP_CONTROL_NAME)
    assert.equal(trip?.state, 'halted')
    assert.match(String(trip?.detail?.reasons?.join(' ')), /consecutive negative months/)
    assert.lengthOf((await OperationAlert.all()).filter((alert) => alert.code === 'tripwire'), 1)

    const before = await TrendEvaluation.all()
    const halted = await service.tick()
    assert.equal(halted.status, 'halted')
    assert.lengthOf(await TrendEvaluation.all(), before.length, 'no runs while halted')

    await service.resume('drawdown investigated and accepted', BASE_NOW)
    const afterResume = await ControlRecord.get(TREND_TRIP_CONTROL_NAME)
    assert.equal(afterResume?.state, 'ok')
    assert.lengthOf((await OperationAlert.all()).filter((alert) => alert.code === 'tripwire-resumed'), 1)

    const advanced = makeService({
      coverage: async () => coverage({ newest: BASE_NOW }),
      runReplay: (symbol: string, samples: BacktestSample[]) =>
        replayResult(symbol, samples, { drawdown: 5, equityCurve: negativeCurve }),
    })
    const tick = await advanced.tick()
    assert.equal(tick.status, 'ok')
    assert.lengthOf(await TrendEvaluation.all(), before.length + 1)
  })

  test('drawdown above 15% latches; at 15% it does not', ({ assert }) => {
    const monthly = [{ period: '2026-01', start: 0, end: 0, startEquity: 100, endEquity: 110, returnPct: 10 }]
    assert.isTrue(evaluateTripwires({ maxDrawdownPct: 15.01, monthly }).tripped)
    assert.isFalse(evaluateTripwires({ maxDrawdownPct: 15, monthly }).tripped)
    assert.include(evaluateTripwires({ maxDrawdownPct: 20, monthly }).reasons.join(' '), 'drawdown')

    const negatives = [
      { period: '2026-01', start: 0, end: 0, startEquity: 100, endEquity: 90, returnPct: -10 },
      { period: '2026-02', start: 0, end: 0, startEquity: 90, endEquity: 80, returnPct: -11.1 },
    ]
    assert.equal(evaluateTripwires({ maxDrawdownPct: 3, monthly: negatives }).tripped, true)
  })

  test('an excessive engine config refuses the tick before any run', async ({ assert }) => {
    const service = makeService()
    const row = await ensureFrozenTrendConfig()
    row.maxExposurePct = 500
    await row.save()

    const result = await service.tick()

    assert.equal(result.status, 'refused')
    assert.lengthOf(await TrendEvaluation.all(), 0)
    assert.lengthOf((await OperationAlert.all()).filter((alert) => alert.code === 'invalid-config'), 1)
  })

  test('a stalled bar store is reported and produces no duplicate evaluation', async ({ assert }) => {
    await ensureFrozenTrendConfig()
    await TrendEvaluation.create({
      symbol: 'BTC',
      intervalSeconds: 300,
      windowStart: BASE_NOW - LOOKBACK * BAR_MS,
      windowEnd: BASE_NOW - BAR_MS,
      bars: LOOKBACK,
      equity: 10000,
      netReturnPct: 0,
      maxDrawdownPct: 0,
      profitFactor: null,
      greenMonths: 0,
      tradeCount: 0,
      state: 'paper',
      provisional: false,
      coverageOk: true,
      configHash: null,
      configSnapshot: null,
      monthly: [],
      quarterly: [],
    } as any)

    const unchanged = await makeService().tick()
    assert.equal(unchanged.results[0].status, 'unchanged')
    assert.lengthOf(await TrendEvaluation.all(), 1)

    const stale = await makeService({ coverage: async () => coverage({ newest: null, bars: 0 }) }).tick()
    assert.equal(stale.results[0].status, 'stale')
  })

  test('the evaluator has no order path or venue client', ({ assert }) => {
    const sources = ['TrendEvalService.ts', 'Tripwire.ts']
      .map((file) => fs.readFileSync(path.join(process.cwd(), 'app', 'services', file), 'utf8'))
      .join('\n')

    assert.notMatch(sources, /placeOrder|cancelOrder|KrakenFastEngine|KrakenEarnClient|KrakenService|IBKRFastEngine/)
  })

  test('stale provisional rows are pruned and concurrent passes are skipped', async ({ assert }) => {
    await ensureFrozenTrendConfig()
    await TrendEvaluation.create({
      symbol: 'BTC',
      intervalSeconds: 300,
      windowStart: BASE_NOW - 90 * 86_400_000,
      windowEnd: BASE_NOW - 40 * 86_400_000,
      bars: 100,
      equity: 10000,
      netReturnPct: 0,
      maxDrawdownPct: 0,
      profitFactor: null,
      greenMonths: null,
      tradeCount: 0,
      state: 'provisional',
      provisional: true,
      coverageOk: false,
      configHash: null,
      configSnapshot: null,
      monthly: null,
      quarterly: null,
    } as any)

    const service = makeService()
    const first = service.tick()
    const second = await service.tick()
    assert.deepEqual(second, { status: 'skipped', reason: 'in-flight' })

    const result = await first
    assert.equal(result.status, 'ok')
    const heartbeat = await ControlRecord.get('trend:eval')
    assert.equal(heartbeat?.detail?.pruned, 1)
    assert.lengthOf(await TrendEvaluation.query().where('state', 'provisional'), 0)
  })
})
