import { test } from '@japa/runner'
import {
  rankInformationCoefficient,
  quintileMeans,
  tStat,
  sharpeRatio,
  deflatedSharpeRatio,
  sweepThresholds,
  fitThresholdPair,
  evaluatePromotion,
  labelOutcomes,
  type LabeledOutcome,
} from '../../app/services/jev_evaluation.js'

// U5 calibration and promotion harness: pure statistics over labeled
// outcomes plus gate arithmetic with declared trial populations. All
// fixtures are synthetic and seeded — deterministic.

// Deterministic PRNG (mulberry32) so the shuffled fixture is stable.
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

/** Separating fixture: confidence tracks the outcome with noise. */
function separating(n = 200, seed = 7): LabeledOutcome[] {
  const rand = prng(seed)
  return Array.from({ length: n }, () => {
    const win = rand() < 0.55
    const confidence = Math.min(0.99, Math.max(0.01, (win ? 0.72 : 0.38) + (rand() - 0.5) * 0.2))
    const edge = Math.min(0.9, Math.max(-0.9, (win ? 0.3 : -0.1) + (rand() - 0.5) * 0.2))
    return { confidence, edge, pnl: win ? 12 : -10 }
  })
}

/** Shuffled fixture: scores carry no information about outcomes. */
function shuffled(n = 200, seed = 21): LabeledOutcome[] {
  const rand = prng(seed)
  return Array.from({ length: n }, () => ({
    confidence: 0.3 + rand() * 0.6,
    edge: (rand() - 0.5) * 0.6,
    pnl: rand() < 0.5 ? 12 : -10,
  }))
}

test.group('Jev information content', () => {
  test('separating fixture shows positive rank IC and monotone quintiles', ({ assert }) => {
    const ic = rankInformationCoefficient(separating())
    assert.isAbove(ic, 0.3)

    const means = quintileMeans(separating())
    assert.equal(means.length, 5)
    for (let i = 1; i < means.length; i++) {
      assert.isAtLeast(means[i], means[i - 1])
    }
  })

  test('shuffled fixture shows no information', ({ assert }) => {
    const ic = rankInformationCoefficient(shuffled())
    assert.isBelow(Math.abs(ic), 0.2)
  })

  test('t-statistic matches the textbook definition', ({ assert }) => {
    assert.closeTo(tStat([2, 4, 6]), 4 / (2 / Math.sqrt(3)), 1e-9)
    assert.equal(tStat([5]), 0)
    assert.equal(tStat([3, 3, 3]), 0)
  })

  test('sharpe annualizes with the period count', ({ assert }) => {
    const monthly = [0.02, 0.03, 0.01, 0.04]
    const sr = sharpeRatio(monthly, 12)
    assert.isAbove(sr, 0)
    assert.closeTo(sr, (tStat(monthly) * Math.sqrt(12)) / 1, 1e-9)
  })
})

test.group('Jev promotion arithmetic', () => {
  test('strong edge with few trials earns a high deflated Sharpe', ({ assert }) => {
    const dsr = deflatedSharpeRatio(2.0, 5, [2.0, 1.8, 2.2, 1.9, 2.1], 1)
    assert.isAbove(dsr, 0.95)
  })

  test('flat edge earns no promotion regardless of trial count', ({ assert }) => {
    const dsr = deflatedSharpeRatio(0.1, 50, Array.from({ length: 50 }, (_, i) => 0.1 + (i % 2 === 0 ? 0.05 : -0.05)), 1)
    assert.isBelow(dsr, 0.5)
  })

  test('nine-trade window fails the sample-size gate instead of promoting', ({ assert }) => {
    const verdict = evaluatePromotion({
      paperDeltaT: 4.5,
      paperTrades: 9,
      dsr: 0.99,
      walkforwardPass: true,
      trialsDeclared: true,
      minTrades: 100,
    })
    assert.isFalse(verdict.promote)
    assert.isTrue(verdict.reasons.some((r) => /9.*100|sample|trade/i.test(r)))
  })

  test('undeclared trials refuse promotion language', ({ assert }) => {
    const verdict = evaluatePromotion({
      paperDeltaT: 3.1,
      paperTrades: 150,
      dsr: 0.97,
      walkforwardPass: true,
      trialsDeclared: false,
      minTrades: 100,
    })
    assert.isFalse(verdict.promote)
    assert.isTrue(verdict.reasons.some((r) => /trial/i.test(r)))
  })

  test('full gates passing promotes with no reasons', ({ assert }) => {
    const verdict = evaluatePromotion({
      paperDeltaT: 2.4,
      paperTrades: 150,
      dsr: 0.97,
      walkforwardPass: true,
      trialsDeclared: true,
      minTrades: 100,
    })
    assert.isTrue(verdict.promote)
    assert.equal(verdict.reasons.length, 0)
  })

  test('failed walk-forward blocks promotion', ({ assert }) => {
    const verdict = evaluatePromotion({
      paperDeltaT: 2.4,
      paperTrades: 150,
      dsr: 0.97,
      walkforwardPass: false,
      trialsDeclared: true,
      minTrades: 100,
    })
    assert.isFalse(verdict.promote)
    assert.isTrue(verdict.reasons.some((r) => /walk-forward/i.test(r)))
  })
})

test.group('Jev threshold fitting', () => {
  const candidates = [
    { minConfidence: 0.5, minEdgePct: 0.1 },
    { minConfidence: 0.6, minEdgePct: 0.15 },
    { minConfidence: 0.7, minEdgePct: 0.2 },
  ]

  test('sweep counts every candidate toward the trial population', ({ assert }) => {
    const swept = sweepThresholds(separating(), candidates)
    assert.equal(swept.length, 3)
    for (const row of swept) {
      assert.isAtLeast(row.covered, 0)
      assert.isTrue(Number.isFinite(row.t))
    }
  })

  test('fit selects the best-t candidate and freezes one versioned pair', ({ assert }) => {
    const { pair, sweep } = fitThresholdPair('jev-1.13.0', 'q1', separating(), candidates, 1_700_000_000_000)
    assert.equal(pair.model, 'jev-1.13.0')
    assert.equal(pair.questionHash, 'q1')
    assert.equal(pair.trials, candidates.length)
    assert.equal(pair.fittedAt, 1_700_000_000_000)
    const best = sweep.reduce((a, b) => (b.t > a.t ? b : a))
    assert.equal(pair.minConfidence, best.minConfidence)
    assert.equal(pair.minEdgePct, best.minEdgePct)
    assert.isAbove(pair.metrics.ic, 0.3)
  })

  test('refit on changed questions versions a new pair', ({ assert }) => {
    const outcomes = separating()
    const first = fitThresholdPair('jev-1.13.0', 'q1', outcomes, candidates, 1_700_000_000_000)
    const second = fitThresholdPair('jev-1.13.0', 'q2', outcomes, candidates, 1_700_000_000_001)
    assert.notEqual(second.pair.questionHash, first.pair.questionHash)
    assert.notEqual(second.pair.fittedAt, first.pair.fittedAt)
  })
})

test.group('Jev outcome labeling', () => {
  test('trades join the latest score at or behind entry time', ({ assert }) => {
    const labeled = labelOutcomes(
      [
        { entryTime: 2000, pnl: 12 },
        { entryTime: 5000, pnl: -10 },
        { entryTime: 500, pnl: 12 },
      ],
      [
        { t: 1000, pUp: 0.7, pDown: 0.2, confidence: 0.8 },
        { t: 3000, pUp: 0.3, pDown: 0.6, confidence: 0.7 },
      ]
    )
    // The 500ms trade predates every score and stays unlabeled.
    assert.equal(labeled.length, 2)
    assert.closeTo(labeled[0].confidence, 0.8, 1e-12)
    assert.closeTo(labeled[1].confidence, 0.7, 1e-12)
    assert.equal(labeled[0].pnl, 12)
  })
})
