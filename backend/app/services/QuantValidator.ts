// ─── Quant-score validation (point-in-time) ────────────────────
//
// Answers the question the screener never could: does the composite score
// (and each component) actually predict forward returns? For every ticker
// it replays the bar history at a coarse cadence, computing the EXACT
// production snapshot (computeIndicatorSnapshot) on data known at time t
// only — no look-ahead — and pairs it with the forward return.
//
// Outputs:
//   - time-series IC per ticker (Spearman composite ↔ forward return),
//     averaged across the universe
//   - cross-sectional IC per date (rank all tickers by score, correlate
//     with rank of forward return)
//   - per-component IC (which inputs carry signal at all)
//   - quintile forward returns (does the top score quintile actually
//     beat the bottom?)
//
// Spearman rho on n pairs: ~1.96/sqrt(n-1) is the 95% null band.

import { computeIndicatorSnapshot } from '#services/QuantEngine'
import { analysesToNewsEvents, newsWindowScore } from '#services/NewsScore'

export interface ValidationRow {
  date: string
  ticker: string
  composite: number
  forwardRet: number | null
  components: Record<string, number>
  /** Which components had data — required to re-score under other weights. */
  present: Record<string, boolean>
}

export interface TickerValidationResult {
  symbol: string
  rows: ValidationRow[]
  rowCount: number
  ic: number | null
  forwardMean: number
}

export interface ValidationSummary {
  tickers: number
  rows: number
  compositeIcTimeSeries: number | null
  compositeIcCrossSectional: number | null
  componentIc: Record<string, number>
  quintileForward: Array<{ label: string; meanForward: number; n: number }>
  nullBand95: number | null
}

const COMPONENT_KEYS = [
  'rsi', 'macd', 'bollingerBands', 'trend', 'adx', 'stochastic',
  'momentum', 'volume', 'patterns', 'sentiment', 'sentimentMomentum',
  'newsVolume', 'sharpe', 'beta', 'pe', 'fiftyTwoWeek',
] as const

/** Rank an array (average ranks on ties). */
function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avg
    i = j + 1
  }
  return ranks
}

/** Spearman rank correlation; null when n < 3 or variance is zero. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null
  const rx = rank(xs)
  const ry = rank(ys)
  const n = rx.length
  const meanX = rx.reduce((s, v) => s + v, 0) / n
  const meanY = ry.reduce((s, v) => s + v, 0) / n
  let num = 0
  let denX = 0
  let denY = 0
  for (let i = 0; i < n; i++) {
    num += (rx[i] - meanX) * (ry[i] - meanY)
    denX += (rx[i] - meanX) ** 2
    denY += (ry[i] - meanY) ** 2
  }
  if (denX === 0 || denY === 0) return null
  return num / Math.sqrt(denX * denY)
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
}

function icStats(ics: Array<number | null>): { ic: number | null; n: number } {
  const valid = ics.filter((v): v is number => v !== null)
  if (valid.length === 0) return { ic: null, n: 0 }
  return { ic: mean(valid), n: valid.length }
}

export interface ValidateTickerOpts {
  symbol: string
  bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>
  analyses: any[]
  spyReturns: number[]
  meta?: any
  secType?: string | null
  step?: number
  forward?: number
  warmup?: number
  sentimentWindowSeconds?: number
}

/** Replay one ticker: point-in-time snapshots × forward returns. */
export function validateTicker(opts: ValidateTickerOpts): TickerValidationResult {
  const step = opts.step || 5
  const forward = opts.forward || 20
  const warmup = opts.warmup || 60
  const sentimentWindow = opts.sentimentWindowSeconds || 30 * 86400
  const rows: ValidationRow[] = []

  for (let i = warmup; i < opts.bars.length - forward; i += step) {
    const bar = opts.bars[i]
    const slice = opts.bars.slice(0, i + 1)
    const atMs = Date.parse(`${bar.date}T23:59:59Z`)

    // Point-in-time sentiment: only events published at/before `at`.
    const events = analysesToNewsEvents(opts.analyses)
      .filter((e) => e.t <= atMs)
    const sentiment = newsWindowScore(events, atMs, sentimentWindow)
    const shifted = newsWindowScore(events, atMs - 7 * 86400, sentimentWindow)
    const sentimentData = {
      totalArticles: sentiment.events,
      avgScore: sentiment.score ?? 0,
      recentTrend: sentiment.score !== null && shifted.score !== null ? sentiment.score - shifted.score : 0,
    }

    const snap = computeIndicatorSnapshot(slice, {
      spyReturns: opts.spyReturns.slice(0, i + 1),
      meta: opts.meta,
      sentiment: sentimentData,
      secType: opts.secType ?? null,
    })

    // Forward return measured on the FULL series (the slice ends at i).
    const forwardRet = opts.bars[i + forward].close / opts.bars[i].close - 1
    rows.push({
      date: bar.date,
      ticker: opts.symbol,
      composite: snap.compositeScore,
      forwardRet,
      present: snap.present,
      components: Object.fromEntries(
        COMPONENT_KEYS.map((k) => [k, snap.breakdown[k as keyof typeof snap.breakdown] ?? 0])
      ),
    })
  }

  const composites = rows.map((r) => r.composite)
  const forwards = rows.map((r) => r.forwardRet ?? 0)
  const ic = spearman(composites, forwards)

  return {
    symbol: opts.symbol,
    rows,
    rowCount: rows.length,
    ic,
    forwardMean: mean(forwards),
  }
}

/** Aggregate per-ticker rows into the validation summary. */
export function summarizeValidation(results: TickerValidationResult[], rowsByTicker: Map<string, ValidationRow[]>): ValidationSummary {
  // Time-series IC: per-ticker Spearman averaged.
  const seriesIcs = results.map((r) => r.ic)
  const { ic: compositeIcTimeSeries } = icStats(seriesIcs)

  // Cross-sectional IC: per date, rank tickers by composite and forward.
  const byDate = new Map<string, { tickers: string[]; composites: number[]; forwards: number[] }>()
  for (const [ticker, rows] of rowsByTicker) {
    for (const r of rows) {
      const entry = byDate.get(r.date)
      if (entry) {
        entry.tickers.push(ticker)
        entry.composites.push(r.composite)
        entry.forwards.push(r.forwardRet ?? 0)
      } else {
        byDate.set(r.date, { tickers: [ticker], composites: [r.composite], forwards: [r.forwardRet ?? 0] })
      }
    }
  }
  const crossIcs: Array<number | null> = []
  for (const entry of byDate.values()) {
    if (entry.tickers.length < 3) continue
    crossIcs.push(spearman(entry.composites, entry.forwards))
  }
  const { ic: compositeIcCrossSectional, n: crossN } = icStats(crossIcs)

  // Component ICs (time-series, pooled per component across tickers).
  const componentIc: Record<string, number> = {}
  for (const key of COMPONENT_KEYS) {
    const ics: Array<number | null> = []
    for (const [ticker, rows] of rowsByTicker) {
      const comps = rows.map((r) => r.components[key])
      const fwds = rows.map((r) => r.forwardRet ?? 0)
      ics.push(spearman(comps, fwds))
    }
    const { ic } = icStats(ics)
    componentIc[key] = ic ?? 0
  }

  // Quintiles of pooled composite scores.
  const pooled = [...rowsByTicker.values()].flat().filter((r) => r.forwardRet !== null)
  const sorted = [...pooled].sort((a, b) => a.composite - b.composite)
  const quintileForward: ValidationSummary['quintileForward'] = []
  const qSize = Math.floor(sorted.length / 5)
  if (qSize >= 2) {
    for (let q = 0; q < 5; q++) {
      const slice = q === 4 ? sorted.slice(q * qSize) : sorted.slice(q * qSize, (q + 1) * qSize)
      if (slice.length === 0) continue
      const labels = ['bottom', 'q2', 'q3', 'q4', 'top']
      quintileForward.push({
        label: labels[q],
        meanForward: mean(slice.map((r) => r.forwardRet!)),
        n: slice.length,
      })
    }
  }

  const rows = [...rowsByTicker.values()].flat().length
  return {
    tickers: results.length,
    rows,
    compositeIcTimeSeries,
    compositeIcCrossSectional,
    componentIc,
    quintileForward,
    nullBand95: crossN > 0 ? 1.96 / Math.sqrt(Math.max(1, crossN - 1)) : null,
  }
}