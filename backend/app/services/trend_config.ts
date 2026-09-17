// ─── Frozen trend config surface ───────────────────────────────
//
// The frozen daily-trend product (ALGO_PRODUCT.md) in FastStrategy SAMPLE
// units for a 5m cadence. Deliberately built directly from literal values:
// routing these periods through fastStrategyFromConfig would rescale them
// by sampleIntervalSeconds and silently turn EMA-288 into EMA-1.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import TrendConfig from '#models/TrendConfig'
import TrendEvaluation from '#models/TrendEvaluation'
import { BacktestEngine, type BacktestResult, type BacktestSample } from '#services/BacktestEngine'
import type { FastStrategyConfig } from '#services/FastStrategy'
import { resampleSamples } from '#app/utils/bar_resample'
import { greenMonthCount, sliceEquityCurve } from '#services/trend_metrics'

export const TREND_INTERVAL_SECONDS = 300
/** Longest lookback: the 14-day efficiency window at 5m. */
export const FROZEN_LOOKBACK_SAMPLES = (14 * 86_400) / TREND_INTERVAL_SECONDS
/** One extra day of samples beyond the longest lookback. */
export const CERTIFICATION_EXTRA_SAMPLES = 86_400 / TREND_INTERVAL_SECONDS
export const CERTIFICATION_MIN_BARS = FROZEN_LOOKBACK_SAMPLES + CERTIFICATION_EXTRA_SAMPLES

const CACHE_DIR = path.join(import.meta.dirname, '..', '..', 'backtests', 'cache')

export const FROZEN_TREND_STRATEGY: FastStrategyConfig = {
  sampleIntervalSeconds: TREND_INTERVAL_SECONDS,
  momentumSeconds: 0,
  momentumThresholdPct: 0,
  rsiLow: 0,
  rsiHigh: 0,
  stopLossPct: 5,
  takeProfitPct: 0,
  exitReversalPct: -99,
  trailingStopPct: 12,
  trailingActivatePct: 6,
  maxHoldSeconds: 0,
  emaPeriod: 288,
  volatilityWindowSamples: 0,
  volatilityMult: 0,
  volatilityFloorPct: 0,
  volatilityCeilingPct: 0,
  trendMode: true,
  trendSlopePct: 1.5,
  trendSlopeWindowSeconds: 259_200,
  regimeEmaPeriod: 1152,
  regimeSlopeWindowSeconds: 604_800,
  regimeSlopeMinPct: 1.5,
  volumeWindowSamples: 0,
  volumeMinRatio: 0,
  trailingVolatilityMult: 0,
  scaleOutPct: 0,
  harVolForecast: false,
  cusumWindowSeconds: 0,
  cusumExitPct: 0,
  jumpSlackPct: 0,
  choppinessPeriod: 0,
  choppinessMax: 0,
  tradeStartUtc: 0,
  tradeEndUtc: 24,
  convictionSizing: false,
  newsGateEnabled: false,
  newsMinSentiment: 0,
  newsMinArticles: 0,
  newsWindowSeconds: 0,
  efficiencyWindowDays: 14,
  efficiencyMinPct: 40,
  efficiencyExitPct: 0,
}

export interface TrendEngineConfig {
  loopIntervalSeconds: number
  portfolioUsd: number
  feePct: number
  slippageBps: number
  maxPositions: number
  maxExposurePct: number
  maxSinglePositionPct: number
  cooldownSeconds: number
}

/** Engine + cost model frozen alongside the strategy (ALGO_PRODUCT.md). */
export const FROZEN_TREND_ENGINE: TrendEngineConfig = {
  loopIntervalSeconds: 300,
  portfolioUsd: 10_000,
  feePct: 0.0026, // 0.26% taker per side
  slippageBps: 10,
  maxPositions: 1,
  maxExposurePct: 0.9,
  maxSinglePositionPct: 0.9,
  cooldownSeconds: 0,
}

/** Row values as persisted (percents stored as percentages). */
export const FROZEN_TREND_ROW = {
  name: 'frozen',
  trendMode: true,
  emaPeriod: 288,
  trendSlopePct: 1.5,
  trendSlopeWindowSeconds: 259_200,
  regimeEmaPeriod: 1152,
  regimeSlopeWindowSeconds: 604_800,
  regimeSlopeMinPct: 1.5,
  efficiencyWindowDays: 14,
  efficiencyMinPct: 40,
  efficiencyExitPct: 0,
  stopLossPct: 5,
  takeProfitPct: 0,
  exitReversalPct: -99,
  trailingStopPct: 12,
  trailingActivatePct: 6,
  cooldownSeconds: 0,
  maxHoldSeconds: 0,
  loopIntervalSeconds: 300,
  capitalPerAssetUsd: 10_000,
  takerFeePct: 0.26,
  slippageBps: 10,
  maxPositions: 1,
  maxExposurePct: 90,
  maxSinglePositionPct: 90,
  extras: null,
}

/** Deterministic JSON with sorted object keys (hash inputs must be stable). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(',')}}`
}

export function trendConfigHash(strategy: FastStrategyConfig, engine: TrendEngineConfig): string {
  return crypto.createHash('sha256').update(stableStringify({ strategy, engine })).digest('hex')
}

/**
 * The row's strategy fields are already in sample units — assign them
 * directly, never through fastStrategyFromConfig. `extras.strategy` can
 * extend fields the table does not express, but the cadence is pinned.
 */
export function strategyConfigFromTrendConfig(row: TrendConfig): FastStrategyConfig {
  return {
    ...FROZEN_TREND_STRATEGY,
    trendMode: row.trendMode,
    emaPeriod: row.emaPeriod,
    trendSlopePct: row.trendSlopePct ?? FROZEN_TREND_STRATEGY.trendSlopePct,
    trendSlopeWindowSeconds: row.trendSlopeWindowSeconds ?? FROZEN_TREND_STRATEGY.trendSlopeWindowSeconds,
    regimeEmaPeriod: row.regimeEmaPeriod ?? FROZEN_TREND_STRATEGY.regimeEmaPeriod,
    regimeSlopeWindowSeconds: row.regimeSlopeWindowSeconds ?? FROZEN_TREND_STRATEGY.regimeSlopeWindowSeconds,
    regimeSlopeMinPct: row.regimeSlopeMinPct ?? FROZEN_TREND_STRATEGY.regimeSlopeMinPct,
    efficiencyWindowDays: row.efficiencyWindowDays ?? FROZEN_TREND_STRATEGY.efficiencyWindowDays,
    efficiencyMinPct: row.efficiencyMinPct ?? FROZEN_TREND_STRATEGY.efficiencyMinPct,
    efficiencyExitPct: row.efficiencyExitPct ?? FROZEN_TREND_STRATEGY.efficiencyExitPct,
    stopLossPct: row.stopLossPct ?? FROZEN_TREND_STRATEGY.stopLossPct,
    takeProfitPct: row.takeProfitPct ?? FROZEN_TREND_STRATEGY.takeProfitPct,
    exitReversalPct: row.exitReversalPct ?? FROZEN_TREND_STRATEGY.exitReversalPct,
    trailingStopPct: row.trailingStopPct ?? FROZEN_TREND_STRATEGY.trailingStopPct,
    trailingActivatePct: row.trailingActivatePct ?? FROZEN_TREND_STRATEGY.trailingActivatePct,
    maxHoldSeconds: row.maxHoldSeconds ?? FROZEN_TREND_STRATEGY.maxHoldSeconds,
    ...(row.extras?.strategy ?? {}),
    sampleIntervalSeconds: TREND_INTERVAL_SECONDS,
  }
}

export function engineConfigFromTrendConfig(row: TrendConfig): TrendEngineConfig {
  return {
    loopIntervalSeconds: row.loopIntervalSeconds ?? FROZEN_TREND_ENGINE.loopIntervalSeconds,
    portfolioUsd: row.capitalPerAssetUsd ?? FROZEN_TREND_ENGINE.portfolioUsd,
    feePct: (row.takerFeePct ?? 0.26) / 100,
    slippageBps: row.slippageBps ?? FROZEN_TREND_ENGINE.slippageBps,
    maxPositions: row.maxPositions ?? FROZEN_TREND_ENGINE.maxPositions,
    maxExposurePct: (row.maxExposurePct ?? 90) / 100,
    maxSinglePositionPct: (row.maxSinglePositionPct ?? 90) / 100,
    cooldownSeconds: row.cooldownSeconds ?? FROZEN_TREND_ENGINE.cooldownSeconds,
  }
}

/** Create the single frozen row when absent; never overwrite operator edits. */
export async function ensureFrozenTrendConfig(): Promise<TrendConfig> {
  const existing = await TrendConfig.query().where('name', 'frozen').first()
  if (existing) return existing
  const row = await TrendConfig.create({ ...FROZEN_TREND_ROW } as any)
  row.configHash = trendConfigHash(strategyConfigFromTrendConfig(row), engineConfigFromTrendConfig(row))
  await row.save()
  return row
}

export function researchCacheFile(symbol: string): string {
  return path.join(CACHE_DIR, `${symbol.toUpperCase()}_1m_1095d.json`)
}

/**
 * Retired Binance 1m research caches, resampled to the frozen cadence.
 * Research-only provenance: never gates the live-paper evaluation (R13).
 */
export function loadResearchSamples(symbol: string, targetSeconds = TREND_INTERVAL_SECONDS): BacktestSample[] {
  const file = researchCacheFile(symbol)
  if (!fs.existsSync(file)) throw new Error(`research cache not found: ${file}`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const samples: BacktestSample[] = Array.isArray(raw) ? raw : (raw.samples ?? [])
  return resampleSamples(samples, 60, targetSeconds)
}

export type TrendProvenance = 'bar_records' | 'kraken' | 'research'

export interface CertificationOptions {
  symbol: string
  samples: BacktestSample[]
  provenance: TrendProvenance
  sourceLabel: string
  configRow?: TrendConfig
  minBars?: number
  coverageOk?: boolean
}

export interface CertificationResult {
  certified: boolean
  reason?: string
  evaluation?: TrendEvaluation
  result?: BacktestResult
}

export async function certifyTrend(opts: CertificationOptions): Promise<CertificationResult> {
  const row = opts.configRow ?? (await ensureFrozenTrendConfig())
  const minBars = opts.minBars ?? CERTIFICATION_MIN_BARS

  if (opts.samples.length < minBars) {
    return {
      certified: false,
      reason: `series has ${opts.samples.length} bars, needs at least ${minBars}`,
    }
  }

  const strategy = strategyConfigFromTrendConfig(row)
  const engine = engineConfigFromTrendConfig(row)
  const result = new BacktestEngine().run(opts.samples, { symbol: opts.symbol, strategy, ...engine })

  const monthly = sliceEquityCurve(result.equityCurve, 'month')
  const quarterly = sliceEquityCurve(result.equityCurve, 'quarter')
  const researchOnly = opts.provenance === 'research'

  const evaluation = await TrendEvaluation.create({
    symbol: opts.symbol,
    intervalSeconds: TREND_INTERVAL_SECONDS,
    windowStart: result.startTime,
    windowEnd: result.endTime,
    bars: result.samples,
    equity: result.endUsd,
    netReturnPct: result.strategyReturnPct,
    maxDrawdownPct: result.metrics.maxDrawdownPct,
    profitFactor: Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor : null,
    greenMonths: greenMonthCount(monthly),
    tradeCount: result.metrics.totalTrades,
    state: researchOnly ? 'research' : 'certified',
    provisional: researchOnly,
    coverageOk: opts.coverageOk ?? !researchOnly,
    configHash: trendConfigHash(strategy, engine),
    configSnapshot: {
      strategy,
      engine,
      provenance: opts.provenance,
      sourceLabel: opts.sourceLabel,
      researchOnly,
    },
    monthly,
    quarterly,
  } as any)

  return { certified: true, evaluation, result }
}

/** Stored-snapshot rendering: a later config edit cannot rewrite these lines. */
export function reportLines(evaluations: TrendEvaluation[]): string[] {
  const lines: string[] = []
  for (const evaluation of evaluations) {
    const snapshot = evaluation.configSnapshot ?? {}
    const provenance = snapshot.provenance ?? 'unknown'
    const label = snapshot.researchOnly
      ? 'research-only (Binance research cache — not Kraken-gated)'
      : `${provenance}${snapshot.sourceLabel ? ` (${snapshot.sourceLabel})` : ''}`
    lines.push(
      `#${evaluation.id} ${evaluation.symbol} ${evaluation.state}${evaluation.provisional ? ' [provisional]' : ''} ` +
        `— ${label}`
    )
    if (evaluation.windowStart && evaluation.windowEnd) {
      lines.push(
        `  window ${new Date(evaluation.windowStart).toISOString()} → ${new Date(evaluation.windowEnd).toISOString()} ` +
          `(${evaluation.bars} bars, hash ${(evaluation.configHash ?? '').slice(0, 12)})`
      )
    }
    lines.push(
      `  net ${(evaluation.netReturnPct ?? 0).toFixed(2)}%  maxDD ${(evaluation.maxDrawdownPct ?? 0).toFixed(2)}%  ` +
        `PF ${evaluation.profitFactor === null ? '—' : evaluation.profitFactor.toFixed(2)}  ` +
        `green months ${evaluation.greenMonths ?? 0}  trades ${evaluation.tradeCount ?? 0}`
    )
    for (const slice of evaluation.monthly ?? []) {
      lines.push(`  ${slice.period}: ${Number(slice.returnPct).toFixed(2)}%`)
    }
  }
  return lines
}
