// ─── Jev calibration and promotion harness (U5) ────────────────────
//
// Pure statistics over labeled outcomes plus promotion-gate arithmetic
// with declared trial populations. No DB, no network, no env — the
// caller (paper evaluator, operator procedure) supplies labeled outcomes
// and trial counts; this module turns them into auditable verdicts.
//
// Conventions: rank-based information coefficient (invariant to monotone
// recalibration), t-statistic on net trade returns, deflated Sharpe ratio
// over the documented trial population (profit-factor ranking is
// multiple-testing-biased and never promotes alone), walk-forward verdict
// supplied by the caller running the backtest command on adjacent windows.

export interface LabeledOutcome {
  confidence: number
  /** Calibrated edge (pDown - pUp) at decision time. */
  edge: number
  /** Net realized P&L of the trade that followed. */
  pnl: number
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function stdev(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1))
}

/** Average ranks (1-based) with ties sharing the mean rank. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const out = new Array<number>(values.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++
    const avg = (i + 1 + j + 1) / 2
    for (let k = i; k <= j; k++) out[order[k].i] = avg
    i = j + 1
  }
  return out
}

/**
 * Rank information coefficient (Spearman): correlation of ranked
 * confidence against ranked P&L. Rank-based, so monotone recalibration
 * cannot move it — the gate half of the map/scale split. 0 when n < 3.
 */
export function rankInformationCoefficient(outcomes: LabeledOutcome[]): number {
  if (outcomes.length < 3) return 0
  const rc = ranks(outcomes.map((o) => o.confidence))
  const rp = ranks(outcomes.map((o) => o.pnl))
  const mc = mean(rc)
  const mp = mean(rp)
  let cov = 0
  let vc = 0
  let vp = 0
  for (let i = 0; i < rc.length; i++) {
    cov += (rc[i] - mc) * (rp[i] - mp)
    vc += (rc[i] - mc) * (rc[i] - mc)
    vp += (rp[i] - mp) * (rp[i] - mp)
  }
  if (vc <= 0 || vp <= 0) return 0
  return cov / Math.sqrt(vc * vp)
}

/** Mean P&L per confidence quintile (ascending) — separation at a glance. */
export function quintileMeans(outcomes: LabeledOutcome[]): number[] {
  if (outcomes.length === 0) return []
  const sorted = [...outcomes].sort((a, b) => a.confidence - b.confidence)
  const buckets = Math.min(5, sorted.length)
  const out: number[] = []
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * sorted.length) / buckets)
    const hi = Math.floor(((b + 1) * sorted.length) / buckets)
    out.push(mean(sorted.slice(lo, Math.max(hi, lo + 1)).map((o) => o.pnl)))
  }
  return out
}

/** One-sample t-statistic of values against zero. 0 when n < 2 or sd = 0. */
export function tStat(values: number[]): number {
  if (values.length < 2) return 0
  const sd = stdev(values)
  if (sd <= 0) return 0
  return (mean(values) / sd) * Math.sqrt(values.length)
}

/** Sharpe ratio against a zero benchmark, annualized by period count. */
export function sharpeRatio(values: number[], periodsPerYear: number): number {
  if (periodsPerYear <= 0) return 0
  return tStat(values) * Math.sqrt(periodsPerYear)
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |ε| ≤ 7.5e-8). */
function phi(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * ax)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * erf)
}

/** Inverse standard normal CDF (Acklam's approximation, ~1e-9). */
function inversePhi(p: number): number {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12)
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  if (q < plow) {
    const r = Math.sqrt(-2 * Math.log(q))
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
  }
  if (q > phigh) {
    const r = Math.sqrt(-2 * Math.log(1 - q))
    return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
  }
  const r = q - 0.5
  const s = r * r
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

const EULER_MASCHERONI = 0.5772156649

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014): probability the
 * observed Sharpe clears the multiple-testing bar. SR0 is the expected
 * maximum Sharpe over N independent trials; V̂ is the empirical dispersion
 * of the trial Sharpe population (directly measures selection luck —
 * wider trial spread raises the bar). N < 2 degrades to the plain
 * Sharpe-vs-zero comparison.
 */
export function deflatedSharpeRatio(sr: number, trials: number, trialsSR: number[], years: number): number {
  const n = Math.max(1, Math.floor(trials))
  if (n < 2 || trialsSR.length < 2 || years <= 0) {
    return phi(sr)
  }
  const variance = Math.max(stdev(trialsSR) ** 2, 1e-12)
  const sd = Math.sqrt(variance)
  const expectedMax =
    sd * ((1 - EULER_MASCHERONI) * inversePhi(1 - 1 / n) + EULER_MASCHERONI * inversePhi(1 - 1 / (n * Math.E)))
  return phi((sr - expectedMax) / sd)
}

export interface SweptCandidate {
  minConfidence: number
  minEdgePct: number
  covered: number
  precision: number
  t: number
  meanPnl: number
}

/**
 * Threshold sweep over labeled outcomes. Every evaluated candidate counts
 * toward the trial population the caller declares — sweeping without
 * declaring is the multiple-testing leak this harness exists to close.
 */
export function sweepThresholds(
  outcomes: LabeledOutcome[],
  candidates: Array<{ minConfidence: number; minEdgePct: number }>
): SweptCandidate[] {
  return candidates.map((c) => {
    const covered = outcomes.filter((o) => o.confidence >= c.minConfidence && o.edge >= c.minEdgePct)
    const wins = covered.filter((o) => o.pnl > 0).length
    const pnls = covered.map((o) => o.pnl)
    return {
      minConfidence: c.minConfidence,
      minEdgePct: c.minEdgePct,
      covered: covered.length,
      precision: covered.length > 0 ? wins / covered.length : 0,
      t: tStat(pnls),
      meanPnl: mean(pnls),
    }
  })
}

export interface FittedPair {
  model: string
  questionHash: string
  minConfidence: number
  minEdgePct: number
  /** Candidates evaluated — the trial population this fit consumed. */
  trials: number
  fittedAt: number
  metrics: { ic: number; t: number; covered: number }
}

/**
 * Fit the gate threshold plus its shrink-map floor as ONE versioned
 * artifact (KTD3): the winner by t-statistic, carrying the model id,
 * question hash, trial count, and fit timestamp. Any model, prompt, or
 * candidate-set change refits — never reuse a pair across a new score
 * distribution.
 */
export function fitThresholdPair(
  model: string,
  questionHash: string,
  outcomes: LabeledOutcome[],
  candidates: Array<{ minConfidence: number; minEdgePct: number }>,
  nowMs: number = Date.now()
): { pair: FittedPair; sweep: SweptCandidate[] } {
  const sweep = sweepThresholds(outcomes, candidates)
  let best = sweep[0]
  for (const row of sweep) {
    if (row.t > best.t) best = row
  }
  return {
    pair: {
      model,
      questionHash,
      minConfidence: best.minConfidence,
      minEdgePct: best.minEdgePct,
      trials: candidates.length,
      fittedAt: nowMs,
      metrics: { ic: rankInformationCoefficient(outcomes), t: best.t, covered: best.covered },
    },
    sweep,
  }
}

export interface PromotionInput {
  paperDeltaT: number
  paperTrades: number
  dsr: number
  walkforwardPass: boolean
  trialsDeclared: boolean
  minTrades?: number
}

/**
 * Promotion gate (R9): every clause must hold or the overlay stays out of
 * enforcement. A refusal names each unmet clause — no silent partial
 * promotion, no profit-factor shortcut.
 */
export function evaluatePromotion(input: PromotionInput): { promote: boolean; reasons: string[] } {
  const reasons: string[] = []
  const minTrades = input.minTrades ?? 100
  if (!input.trialsDeclared) {
    reasons.push('trial population undeclared — declare every evaluated candidate before any promotion claim')
  }
  if (input.paperTrades < minTrades) {
    reasons.push(`sample-size gate: ${input.paperTrades} paper trades below the ${minTrades}-trade minimum`)
  }
  if (input.paperDeltaT < 2) {
    reasons.push(`paper t-statistic ${input.paperDeltaT.toFixed(2)} below the 2.0 bar`)
  }
  if (input.dsr <= 0.95) {
    reasons.push(`deflated Sharpe ${input.dsr.toFixed(3)} at or below the 0.95 bar`)
  }
  if (!input.walkforwardPass) {
    reasons.push('walk-forward out-of-sample window did not pass')
  }
  return { promote: reasons.length === 0, reasons }
}

/**
 * Join closed trades to the latest recorded score at or behind each entry
 * time. Trades predating every score stay unlabeled (returned set shrinks)
 * — certifying them would invent evidence.
 */
export function labelOutcomes(
  trades: Array<{ entryTime: number; pnl: number }>,
  events: Array<{ t: number; pUp: number | null; pDown: number | null; confidence: number | null }>
): LabeledOutcome[] {
  const ordered = [...events].sort((a, b) => a.t - b.t)
  const out: LabeledOutcome[] = []
  for (const trade of trades) {
    let latest: (typeof ordered)[number] | null = null
    for (const event of ordered) {
      if (event.t > trade.entryTime) break
      latest = event
    }
    if (!latest || latest.confidence === null || latest.pUp === null || latest.pDown === null) continue
    out.push({ confidence: latest.confidence, edge: latest.pDown - latest.pUp, pnl: trade.pnl })
  }
  return out
}
