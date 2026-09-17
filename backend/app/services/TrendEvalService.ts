// ─── Trend paper evaluator ─────────────────────────────────────
//
// After each closed bar, replay the stored bar_records series through the
// SAME BacktestEngine + FastStrategy the backtests use (structural parity:
// there is no separate live-paper code path), persist the evaluation, and
// evaluate the latching tripwires. No order path, no venue client, no
// position table — the evaluator reads bars and writes snapshots only.

import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import TrendConfig from '#models/TrendConfig'
import TrendEvaluation from '#models/TrendEvaluation'
import OperationAlert from '#models/OperationAlert'
import ControlRecord from '#models/ControlRecord'
import { BacktestEngine, type BacktestResult, type BacktestSample } from '#services/BacktestEngine'
import { loadBacktestSamples } from '#services/backtest_data'
import BarRecorderService, { DEFAULT_BAR_SYMBOLS, type BarCoverage } from '#services/BarRecorderService'
import {
  FROZEN_LOOKBACK_SAMPLES,
  TREND_INTERVAL_SECONDS,
  ensureFrozenTrendConfig,
  engineConfigFromTrendConfig,
  strategyConfigFromTrendConfig,
  trendConfigHash,
  validateTrendEngineConfig,
} from '#services/trend_config'
import { greenMonthCount, sliceEquityCurve } from '#services/trend_metrics'
import { evaluateTripwires } from '#services/Tripwire'

export const TREND_LOCK_NAME = 'trend:eval'
export const TREND_TRIP_CONTROL_NAME = 'trend:trip'
export const TREND_EVAL_INTERVAL_MS = 5 * 60 * 1000
export const TREND_MAX_HOURS = 24 * 365

export interface TrendEvalOptions {
  symbols?: string[]
  now?: () => number
  loadSamples?: (symbol: string, hours: number) => Promise<BacktestSample[]>
  coverage?: (symbol: string, intervalSeconds: number) => Promise<BarCoverage>
  runReplay?: (symbol: string, samples: BacktestSample[], cfg: any) => BacktestResult
  configRow?: () => Promise<TrendConfig>
  lookbackSamples?: number
  lockTtlMs?: number
  hours?: number
}

export interface EvaluateOptions {
  coverageGap?: boolean
  /** Config row already loaded by the caller (avoids a second SELECT). */
  config?: TrendConfig
}

class TrendEvalService {
  private symbols: string[]
  private now: () => number
  private loadSamples: (symbol: string, hours: number) => Promise<BacktestSample[]>
  private coverageFn: (symbol: string, intervalSeconds: number) => Promise<BarCoverage>
  private replay: (symbol: string, samples: BacktestSample[], cfg: any) => BacktestResult
  private configRow: () => Promise<TrendConfig>
  private lookbackSamples: number
  private lockTtlMs: number
  private hours: number

  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private startedAt: number | null = null
  private lastRunAt: number | null = null

  constructor(opts: TrendEvalOptions = {}) {
    this.symbols = opts.symbols ?? DEFAULT_BAR_SYMBOLS
    this.now = opts.now ?? Date.now
    this.hours = opts.hours ?? TREND_MAX_HOURS
    this.loadSamples =
      opts.loadSamples ??
      (async (symbol, hours) => {
        const loaded = await loadBacktestSamples({
          symbol,
          intervalSeconds: TREND_INTERVAL_SECONDS,
          hours,
          source: 'bar_records',
          broker: 'kraken',
        })
        return loaded.samples
      })
    this.coverageFn =
      opts.coverage ?? ((symbol, intervalSeconds) => BarRecorderService.coverage(symbol, intervalSeconds))
    this.replay = opts.runReplay ?? ((symbol, samples, cfg) => new BacktestEngine().run(samples, cfg))
    this.configRow = opts.configRow ?? ensureFrozenTrendConfig
    this.lookbackSamples = opts.lookbackSamples ?? FROZEN_LOOKBACK_SAMPLES
    this.lockTtlMs = opts.lockTtlMs ?? 10 * 60 * 1000
  }

  public get running(): boolean {
    return this.timer !== null
  }

  public start(symbols?: string[]): void {
    if (this.timer) return
    if (symbols && symbols.length > 0) this.symbols = symbols
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, TREND_EVAL_INTERVAL_MS)
    this.startedAt = this.now()
    logger.info('[TrendEval] Paper evaluator running for %s', this.symbols.join(', '))
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    logger.info('[TrendEval] Stopped')
  }

  /** One evaluator pass. Durable lock; skips when the store has not advanced. */
  public async tick(): Promise<Record<string, any>> {
    if (this.inFlight) return { status: 'skipped', reason: 'in-flight' }
    this.inFlight = true
    try {
      const now = this.now()
      let config: TrendConfig
      try {
        config = await this.configRow()
        validateTrendEngineConfig(engineConfigFromTrendConfig(config))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await OperationAlert.raise({ source: 'trend', severity: 'critical', code: 'invalid-config', message, now })
        return { status: 'refused', reason: message }
      }

      const trip = await ControlRecord.get(TREND_TRIP_CONTROL_NAME)
      if (trip?.state === 'halted') {
        return { status: 'halted', reasons: trip.detail?.reasons ?? [] }
      }

      const acquired = await ControlRecord.tryAcquire(TREND_LOCK_NAME, 'trend-eval', this.lockTtlMs, now)
      if (!acquired) return { status: 'skipped', reason: 'lock-held' }

      try {
        const results: any[] = []
        for (const symbol of this.symbols) {
          const coverage = await this.coverageFn(symbol, TREND_INTERVAL_SECONDS)
          if (coverage.newest === null) {
            results.push({ symbol, status: 'stale', reason: 'no recorded bars' })
            continue
          }

          const previous = await TrendEvaluation.query()
            .where('symbol', symbol)
            .orderBy('window_end', 'desc')
            .first()
          if (previous?.windowEnd && previous.windowEnd >= coverage.newest) {
            results.push({ symbol, status: 'unchanged' })
            continue
          }

          const samples = await this.loadSamples(symbol, this.hours)
          const evaluation = await this.evaluateSamples(symbol, samples, {
            coverageGap: coverage.gaps.length > 0,
            config,
          })
          results.push({
            symbol,
            status: 'evaluated',
            state: evaluation.state,
            bars: evaluation.bars,
            netReturnPct: evaluation.netReturnPct,
          })
        }

        const pruned = await this.pruneProvisional(now)
        this.lastRunAt = this.now()
        await ControlRecord.heartbeat(TREND_LOCK_NAME, 'trend-eval', this.lastRunAt, { results, pruned })
        return { status: 'ok', results }
      } finally {
        await ControlRecord.release(TREND_LOCK_NAME, 'trend-eval')
      }
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Replay + persist + tripwire check for one symbol. A run shorter than the
   * longest lookback, or one whose window contains a coverage gap, is
   * persisted as provisional (no monthly slices, no tripwire arithmetic).
   */
  public async evaluateSamples(
    symbol: string,
    samples: BacktestSample[],
    opts: EvaluateOptions = {}
  ): Promise<TrendEvaluation> {
    const config = opts.config ?? (await this.configRow())
    const strategy = strategyConfigFromTrendConfig(config)
    const engine = engineConfigFromTrendConfig(config)
    validateTrendEngineConfig(engine)

    const result = this.replay(symbol, samples, { symbol, strategy, ...engine })
    const decisionGrade = samples.length >= this.lookbackSamples && !opts.coverageGap

    const monthly = decisionGrade ? sliceEquityCurve(result.equityCurve, 'month') : null
    const quarterly = decisionGrade ? sliceEquityCurve(result.equityCurve, 'quarter') : null

    const evaluation = await TrendEvaluation.create({
      symbol,
      intervalSeconds: TREND_INTERVAL_SECONDS,
      windowStart: result.startTime,
      windowEnd: result.endTime,
      bars: result.samples,
      equity: result.endUsd,
      netReturnPct: result.strategyReturnPct,
      maxDrawdownPct: result.metrics.maxDrawdownPct,
      profitFactor: Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor : null,
      greenMonths: monthly ? greenMonthCount(monthly) : null,
      tradeCount: result.metrics.totalTrades,
      state: decisionGrade ? 'paper' : 'provisional',
      provisional: !decisionGrade,
      coverageOk: !opts.coverageGap,
      configHash: trendConfigHash(strategy, engine),
      configSnapshot: { strategy, engine, provenance: 'bar_records' },
      monthly,
      quarterly,
    } as any)

    if (decisionGrade) {
      const verdict = evaluateTripwires({
        maxDrawdownPct: result.metrics.maxDrawdownPct,
        monthly,
      })
      if (verdict.tripped) {
        await ControlRecord.setState(TREND_TRIP_CONTROL_NAME, 'halted', { reasons: verdict.reasons, at: this.now() })
        await OperationAlert.raise({
          source: 'trend',
          severity: 'critical',
          code: 'tripwire',
          message: `trend evaluation halted: ${verdict.reasons.join('; ')}`,
          now: this.now(),
        })
      }
    }

    return evaluation
  }

  /** Explicit, reasoned resume after a latched tripwire. */
  public async resume(reason: string, now = Date.now()): Promise<void> {
    if (!reason || !reason.trim()) throw new Error('resume requires a reason')
    await ControlRecord.setState(TREND_TRIP_CONTROL_NAME, 'ok', { resumeReason: reason, at: now })
    await OperationAlert.raise({
      source: 'trend',
      severity: 'info',
      code: 'tripwire-resumed',
      message: `trend evaluation resumed: ${reason}`,
      now,
    })
  }

  /** Provisional rows are not evidence: prune them after 30 days. */
  private async pruneProvisional(now: number): Promise<number> {
    const cutoff = now - 30 * 86_400_000
    const deleted = await db
      .from('trend_evaluations')
      .where('state', 'provisional')
      .where('window_end', '<', cutoff)
      .del()
    return Number(deleted) || 0
  }

  public async status(now = Date.now()): Promise<Record<string, any>> {
    const trip = await ControlRecord.get(TREND_TRIP_CONTROL_NAME)
    const lastTick = await ControlRecord.get(TREND_LOCK_NAME)
    const evaluations = await TrendEvaluation.query().orderBy('window_end', 'desc').limit(10)
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      trip: {
        state: trip?.state ?? 'ok',
        reasons: trip?.detail?.reasons ?? [],
        since: trip?.detail?.at ?? null,
      },
      lastTick: {
        at: lastTick?.heartbeatAt ?? null,
        stale: ControlRecord.isRowStale(lastTick, now, 2 * TREND_EVAL_INTERVAL_MS),
        detail: lastTick?.detail ?? null,
      },
      evaluations: evaluations.map((evaluation) => ({
        id: evaluation.id,
        symbol: evaluation.symbol,
        state: evaluation.state,
        provisional: evaluation.provisional,
        windowStart: evaluation.windowStart,
        windowEnd: evaluation.windowEnd,
        bars: evaluation.bars,
        netReturnPct: evaluation.netReturnPct,
        maxDrawdownPct: evaluation.maxDrawdownPct,
        greenMonths: evaluation.greenMonths,
        tradeCount: evaluation.tradeCount,
        coverageOk: evaluation.coverageOk,
      })),
    }
  }
}

export default new TrendEvalService()
export { TrendEvalService }
