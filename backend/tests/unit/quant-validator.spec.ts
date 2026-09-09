import { test } from '@japa/runner'
import { spearman, validateTicker, summarizeValidation } from '../../app/services/QuantValidator.js'

// QuantValidator: Spearman IC math + point-in-time replay through the
// production snapshot path.

test.group('spearman', () => {
  test('perfect positive correlation', ({ assert }) => {
    const ic = spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])
    assert.closeTo(ic!, 1, 1e-9)
  })

  test('perfect negative correlation', ({ assert }) => {
    const ic = spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])
    assert.closeTo(ic!, -1, 1e-9)
  })

  test('monotone but non-linear still yields 1', ({ assert }) => {
    const ic = spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])
    assert.closeTo(ic!, 1, 1e-9)
  })

test('ties get average ranks', ({ assert }) => {
  const ic = spearman([1, 2, 2, 2, 5], [1, 2, 3, 4, 5])
  // Ranks of xs: 1, 3, 3, 3, 5; ys: 1..5 → rho = 8/sqrt(8·10).
  assert.closeTo(ic!, 8 / Math.sqrt(80), 1e-9)
})

  test('null for tiny or constant input', ({ assert }) => {
    assert.isNull(spearman([1, 2], [1, 2]))
    assert.isNull(spearman([5, 5, 5, 5, 5], [1, 2, 3, 4, 5]))
  })
})

function bars(prices: number[]): any[] {
  return prices.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: close, high: close, low: close, close, volume: 1_000_000,
  }))
}

test.group('validateTicker', () => {
  test('replays point-in-time snapshots and pairs them with forward returns', ({ assert }) => {
    // Wavy trend: momentum/RSI vary over time, so composite ranks vary and
    // the IC is measurable (a perfectly smooth series saturates all
    // components → constant score → no rank signal).
    const prices = Array.from({ length: 200 }, (_, i) =>
      100 * (1 + 0.0003 * i + 0.03 * Math.sin(i / 8))
    )
    const result = validateTicker({
      symbol: 'TEST',
      bars: bars(prices),
      analyses: [],
      spyReturns: [],
      step: 5,
      forward: 10,
      warmup: 60,
    })

    assert.isAbove(result.rowCount, 10)
    assert.isNotNull(result.ic)
    assert.equal(result.rows.length, result.rowCount)
    // Point-in-time: every row's date is within the series.
    for (const row of result.rows) {
      assert.match(row.date, /^2026-01-\d\d$/)
      assert.isNotNull(row.forwardRet)
    }
  })

  test('forward returns are measured from the decision close', ({ assert }) => {
    const prices = Array.from({ length: 150 }, (_, i) => 100 * Math.pow(1.001, i))
    const result = validateTicker({
      symbol: 'TEST', bars: bars(prices), analyses: [], spyReturns: [],
      step: 1, forward: 5, warmup: 100,
    })
    const last = result.rows[result.rows.length - 1]
    // Decision at bar 149-5-... last decision i = 149-5 = 144.
    const i = 144
    const expected = prices[i + 5] / prices[i] - 1
    assert.closeTo(last.forwardRet!, expected, 1e-9)
  })

  test('future analyses are excluded (no look-ahead in sentiment)', ({ assert }) => {
    const prices = Array.from({ length: 120 }, (_, i) => 100 * Math.pow(1.001, i))
    // One strongly negative analysis published LATE in the series — it must
    // not affect earlier decision points.
    const analyses = [{
      tickerId: 1, articleId: 1,
      sentimentScore: -0.9, relevanceScore: 0.9, confidence: 0.9,
      eventKey: 'late-bad-news',
      publishedAt: '2026-01-28T12:00:00Z',
      createdAt: '2026-01-28T12:00:00Z',
    }]
    const result = validateTicker({
      symbol: 'TEST', bars: bars(prices), analyses, spyReturns: [],
      step: 2, forward: 5, warmup: 60,
    })

    const earlyRows = result.rows.filter((r) => r.date < '2026-01-25')
    assert.isAbove(earlyRows.length, 0)
    for (const row of earlyRows) {
      assert.equal(row.components.sentiment, 0, 'late news leaked into an early decision')
    }
  })
})

test.group('summarizeValidation', () => {
  test('cross-sectional IC and quintiles aggregate pooled rows', ({ assert }) => {
    const mkRows = (symbol: string, comps: number[], fwds: number[]) =>
      comps.map((composite, i) => ({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        ticker: symbol,
        composite,
        forwardRet: fwds[i],
        components: { rsi: composite, momentum: composite, sentiment: 0 },
      }))

    const a = mkRows('A', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const b = mkRows('B', [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], [10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    const c = mkRows('C', [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const byTicker = new Map([['A', a], ['B', b], ['C', c]])
    const summary = summarizeValidation(
      [
        { symbol: 'A', rows: a, rowCount: a.length, ic: 1, forwardMean: 0.1 },
        { symbol: 'B', rows: b, rowCount: b.length, ic: -1, forwardMean: 0.1 },
        { symbol: 'C', rows: c, rowCount: c.length, ic: 1, forwardMean: 0.1 },
      ],
      byTicker
    )

    assert.equal(summary.tickers, 3)
    assert.equal(summary.rows, 30)
    assert.isNotNull(summary.compositeIcCrossSectional)
    assert.isNotNull(summary.nullBand95)
    assert.isAbove(summary.quintileForward.length, 0)
    assert.equal(summary.quintileForward[0].label, 'bottom')
  })
})