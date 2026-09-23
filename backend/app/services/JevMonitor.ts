import db from '@adonisjs/lucid/services/db'
import JevRollout from '#services/JevRollout'
import { pruneMlScores } from '#services/backtest_data'
import { JEV_PRICE_PER_K_INPUT_USD, JEV_PRICE_PER_K_OUTPUT_USD } from '#services/JevDecisionService'

// ─── Jev observability and operating cost (U7) ───────────────────
//
// Pure math (ECE, PSI, directional precision, spend) plus the scheduled
// monitor: scores from ml_scores joined to realized bar direction from
// tick_records, breach evaluation against alert thresholds, prune
// enforcement, and the latching tripwire on breach. Run via
// `bun ace.js jev:monitor` on a schedule (see docs/runbooks/jev-overlay.md)
// — deliberately no in-process trigger, mirroring the yield line.

export interface CalibratedScore {
  confidence: number
  predicted: boolean
  outcome: boolean
}

/**
 * Expected calibration error: mean |confidence − accuracy| over decile
 * bins. 0 when the stated confidence matches the observed hit rate.
 */
export function expectedCalibrationError(scores: CalibratedScore[], bins = 10): number {
  if (scores.length === 0) return 0
  let weighted = 0
  for (let b = 0; b < bins; b++) {
    const lo = b / bins
    const hi = (b + 1) / bins
    const bucket = scores.filter((s) => s.confidence >= lo && (b === bins - 1 || s.confidence < hi))
    if (bucket.length === 0) continue
    const accuracy = bucket.filter((s) => s.predicted === s.outcome).length / bucket.length
    const meanConf = bucket.reduce((sum, s) => sum + s.confidence, 0) / bucket.length
    weighted += (bucket.length / scores.length) * Math.abs(meanConf - accuracy)
  }
  return weighted
}

/**
 * Population stability index between a baseline and a current confidence
 * sample (decile bins, epsilon-guarded). < 0.1 = stable, > 0.25 = drifted.
 */
export function populationStabilityIndex(expected: number[], actual: number[], bins = 10): number {
  if (expected.length === 0 || actual.length === 0) return 0
  const epsilon = 1e-6
  let psi = 0
  for (let b = 0; b < bins; b++) {
    const lo = b / bins
    const hi = (b + 1) / bins
    const inBin = (v: number) => (v >= lo && (b === bins - 1 || v < hi) ? 1 : 0)
    const e = Math.max(expected.reduce((s, v) => s + inBin(v), 0) / expected.length, epsilon)
    const a = Math.max(actual.reduce((s, v) => s + inBin(v), 0) / actual.length, epsilon)
    psi += (a - e) * Math.log(a / e)
  }
  return psi
}

/** Fraction of directional calls that proved correct. Null when empty. */
export function directionalPrecision(calls: Array<{ predicted: boolean; outcome: boolean }>): number | null {
  if (calls.length === 0) return null
  return calls.filter((c) => c.predicted === c.outcome).length / calls.length
}

export interface SpendSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  spendUsd: number
}

/** Spend from recorded token usage at the documented Jev prices. */
export function spendReport(rows: Array<{ inputTokens: number; outputTokens: number }>): SpendSummary {
  const inputTokens = rows.reduce((s, r) => s + (r.inputTokens || 0), 0)
  const outputTokens = rows.reduce((s, r) => s + (r.outputTokens || 0), 0)
  return {
    calls: rows.length,
    inputTokens,
    outputTokens,
    spendUsd: (inputTokens / 1000) * JEV_PRICE_PER_K_INPUT_USD + (outputTokens / 1000) * JEV_PRICE_PER_K_OUTPUT_USD,
  }
}

export interface MonitorOptions {
  symbols: string[]
  /** Trailing window in days. */
  windowDays?: number
  /** Realized-direction horizon in minutes after each score. */
  horizonMinutes?: number
  /** Latch the overlay when ECE exceeds this. */
  eceBreach?: number
  /** Latch the overlay when PSI exceeds this. */
  psiBreach?: number
  /** Retention in days enforced by this run. */
  retentionDays?: number
  now?: number
}

export interface MonitorReport {
  breached: boolean
  ece: number
  psi: number
  precision: number | null
  scoredDecisions: number
  labeledDecisions: number
  spend: SpendSummary
  pruned: number
}

interface ScoredRow {
  decided_at: number
  p_up: number | null
  p_down: number | null
  confidence: number | null
  input_tokens: number | null
  output_tokens: number | null
}

export class JevMonitor {
  /**
   * One scheduled pass: label recorded scores against realized bar
   * direction, score calibration and drift, report spend, enforce
   * retention, and latch on breach. Latching is the only mutation —
   * everything else reads.
   */
  public async run(opts: MonitorOptions): Promise<MonitorReport> {
    const now = opts.now ?? Date.now()
    const windowDays = opts.windowDays ?? 7
    const horizonMs = (opts.horizonMinutes ?? 5) * 60_000
    const start = now - windowDays * 86400_000

    const calibrated: CalibratedScore[] = []
    const confidences: number[] = []
    const calls: Array<{ predicted: boolean; outcome: boolean }> = []
    const spendRows: Array<{ inputTokens: number; outputTokens: number }> = []
    let scoredDecisions = 0

    for (const symbol of opts.symbols) {
      const scores = (await db
        .from('ml_scores')
        .where('symbol', symbol)
        .where('decided_at', '>=', start)
        .where('fixture', false)
        .orderBy('decided_at', 'asc')) as ScoredRow[]
      scoredDecisions += scores.length
      for (const score of scores) {
        spendRows.push({
          inputTokens: Number(score.input_tokens) || 0,
          outputTokens: Number(score.output_tokens) || 0,
        })
        if (score.confidence === null || score.p_up === null || score.p_down === null) continue
        confidences.push(score.confidence)
        const predicted = score.p_up >= score.p_down
        const base = await this.barClose(symbol, score.decided_at)
        const ahead = await this.barClose(symbol, score.decided_at + horizonMs, true)
        if (base === null || ahead === null) continue
        const outcome = ahead > base === predicted
        calibrated.push({ confidence: score.confidence, predicted, outcome })
        calls.push({ predicted, outcome })
      }
    }

    // Drift baseline: the first half of the window vs the second half.
    const half = Math.floor(confidences.length / 2)
    const ece = expectedCalibrationError(calibrated)
    const psi = populationStabilityIndex(confidences.slice(0, half), confidences.slice(half))
    const precision = directionalPrecision(calls)
    const spend = spendReport(spendRows)
    const pruned = await pruneMlScores(now - (opts.retentionDays ?? 90) * 86400_000)

    const breached =
      (opts.eceBreach !== undefined && ece > opts.eceBreach) ||
      (opts.psiBreach !== undefined && psi > opts.psiBreach)
    if (breached) {
      await JevRollout.evaluateTripwire({ consecutiveNegativePeriods: 0, calibrationBreach: true })
    }

    return { breached, ece, psi, precision, scoredDecisions, labeledDecisions: calibrated.length, spend, pruned }
  }

  /**
   * Closest 1s-bar close at or behind t — or strictly after t when
   * `after` is set (realized horizon lookup).
   */
  private async barClose(symbol: string, t: number, after = false): Promise<number | null> {
    const query = db.from('tick_records').where('symbol', symbol)
    if (after) query.where('ts', '>', t).orderBy('ts', 'asc')
    else query.where('ts', '<=', t).orderBy('ts', 'desc')
    const row = await query.first()
    if (!row || row.close === null || row.close === undefined) return null
    return Number(row.close)
  }
}
