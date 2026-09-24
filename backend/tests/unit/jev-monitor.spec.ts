import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  expectedCalibrationError,
  populationStabilityIndex,
  directionalPrecision,
  spendReport,
  JevMonitor,
} from '../../app/services/JevMonitor.js'
import JevRollout from '../../app/services/JevRollout.js'
import OperationAlert from '../../app/models/OperationAlert.js'

// U7 observability: calibration error, score-distribution drift, directional
// precision, and spend accounting over recorded scores plus the scheduled
// monitor that latches the overlay on breach. Pure math is fixture-driven;
// the orchestrated run uses the throwaway unit DB.

function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test.group('Jev calibration math', () => {
  test('well-calibrated scores show near-zero ECE', ({ assert }) => {
    const rand = prng(3)
    const scores = Array.from({ length: 200 }, () => {
      const win = rand() < 0.8
      return { confidence: 0.8, predicted: true, outcome: win }
    })
    assert.isBelow(expectedCalibrationError(scores), 0.08)
  })

  test('overconfident scores show large ECE', ({ assert }) => {
    const rand = prng(4)
    const scores = Array.from({ length: 200 }, () => {
      const win = rand() < 0.5
      return { confidence: 0.95, predicted: true, outcome: win }
    })
    assert.isAbove(expectedCalibrationError(scores), 0.3)
  })

  test('identical distributions show zero drift, shifted ones trip the wire', ({ assert }) => {
    const rand = prng(5)
    const base = Array.from({ length: 300 }, () => 0.3 + rand() * 0.4)
    const same = [...base]
    const shifted = Array.from({ length: 300 }, () => 0.7 + rand() * 0.25)
    assert.closeTo(populationStabilityIndex(base, same), 0, 1e-9)
    assert.isAbove(populationStabilityIndex(base, shifted), 0.25)
  })

  test('directional precision counts correct confident calls', ({ assert }) => {
    const precision = directionalPrecision([
      { predicted: true, outcome: true },
      { predicted: true, outcome: true },
      { predicted: false, outcome: true },
      { predicted: false, outcome: false },
    ])
    assert.closeTo(precision ?? 0, 0.75, 1e-12)
    assert.isNull(directionalPrecision([]))
  })

  test('spend report prices input tokens with free output', ({ assert }) => {
    const report = spendReport([
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { inputTokens: 1_000_000, outputTokens: 0 },
    ])
    assert.equal(report.calls, 2)
    assert.equal(report.inputTokens, 2_000_000)
    // $0.042/MTok input, output free: 2M input tokens = $0.084.
    assert.closeTo(report.spendUsd, 0.084, 1e-9)
    assert.equal(report.outputTokens, 500_000)
  })
})

test.group('Jev scheduled monitor', (group) => {
  group.each.setup(async () => {
    await db.from('ml_scores').del()
    await db.from('tick_records').del()
    await db.from('control').where('name', 'like', 'jev:%').del()
    await db.from('operation_alerts').where('source', 'jev').del()
  })

  // Seeds are anchored to the run time: the monitor reads a trailing
  // window, so fixed historical timestamps would fall outside it.
  const now = Date.now()
  const T1 = now - 70 * 60_000

  async function seedMarket() {
    // Gently rising 1s bars across the window, inserted in chunks to stay
    // under SQLite's per-statement variable limit.
    for (let base = 0; base < 4200; base += 200) {
      const rows = []
      for (let i = base; i < Math.min(base + 200, 4200); i++) {
        const price = 100 * Math.pow(1.00001, i)
        rows.push({ symbol: 'BTC', ts: T1 + i * 1000, open: price, high: price, low: price, close: price, volume: 1 })
      }
      await db.table('tick_records').insert(rows)
    }
  }

  async function seedScores(upBias: boolean) {
    // Confident reads matching (or fighting) the rising market.
    const rows = []
    for (let i = 0; i < 60; i++) {
      rows.push({
        symbol: 'BTC',
        decided_at: T1 + i * 60_000,
        model: 'jev-1.13.0',
        question_hash: 'q1',
        prompt_version: 'v1',
        window_seconds: 0,
        p_up: upBias ? 0.75 : 0.2,
        p_down: upBias ? 0.18 : 0.72,
        confidence: 0.8,
        latency_ms: 120,
        input_tokens: 700,
        output_tokens: 0,
        stale: false,
        fixture: false,
      })
    }
    await db.table('ml_scores').insert(rows)
  }

  test('empty window reports insufficient data and latches nothing', async ({ assert }) => {
    const monitor = new JevMonitor()
    const report = await monitor.run({ symbols: ['BTC'], windowDays: 2, horizonMinutes: 5 })

    assert.isTrue(report.dataInsufficient)
    assert.isFalse(report.breached)
    assert.isFalse(await JevRollout.isLatched())
    const unacked = await OperationAlert.unacknowledged('jev')
    assert.isEmpty(unacked)
  })

  test('stable window reports metrics without latching', async ({ assert }) => {
    await seedMarket()
    await seedScores(true)
    const monitor = new JevMonitor()
    const report = await monitor.run({ symbols: ['BTC'], windowDays: 2, horizonMinutes: 5 })

    assert.isFalse(report.breached)
    assert.isBelow(report.ece, 0.25)
    assert.isFalse(await JevRollout.isLatched())
    assert.isAbove(report.scoredDecisions, 0)
    assert.closeTo(report.spend.spendUsd, 60 * 700 * 0.042 / 1_000_000, 1e-9)
  })

  test('miscalibrated window latches the overlay with an alert', async ({ assert }) => {
    await seedMarket()
    await seedScores(false)
    const monitor = new JevMonitor()
    const report = await monitor.run({ symbols: ['BTC'], windowDays: 2, horizonMinutes: 5, eceBreach: 0.2 })

    assert.isTrue(report.breached)
    assert.isAbove(report.ece, 0.2)
    assert.isTrue(await JevRollout.isLatched())
    const unacked = await OperationAlert.unacknowledged('jev')
    assert.isTrue(unacked.some((a) => a.code === 'jev-latched'))
  })

  test('monitor run prunes scores past retention', async ({ assert }) => {
    await seedMarket()
    await db.table('ml_scores').insert({
      symbol: 'BTC',
      decided_at: Date.now() - 200 * 86400_000,
      model: 'm',
      question_hash: 'q',
      prompt_version: 'v1',
      window_seconds: 0,
      p_up: 0.5,
      p_down: 0.4,
      confidence: 0.6,
      latency_ms: 1,
      input_tokens: 10,
      output_tokens: 0,
      stale: false,
      fixture: false,
    })
    const monitor = new JevMonitor()
    const report = await monitor.run({ symbols: ['BTC'], windowDays: 2, horizonMinutes: 5, retentionDays: 90 })
    assert.isAtLeast(report.pruned, 1)
    const remaining = await db.from('ml_scores').select('decided_at')
    assert.isTrue(remaining.every((r: any) => Number(r.decided_at) > Date.now() - 90 * 86400_000 - 60_000))
  })
})
