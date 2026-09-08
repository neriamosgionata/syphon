// ─── Daily-trend product config (frozen 2026-09-07) ───────────
//
// Single source of truth for the ER14d/40 daily-trend composite
// (see ALGO_PRODUCT.md). Shape = an AlgoConfig-like row so the standard
// `fastStrategyFromConfig` interval normalization applies — the same code
// path the eval commands and (future) live daily loop will use.
//
// Row semantics: time lookbacks are in SECONDS (fastEmaPeriod = 86400 is a
// 1-day EMA at any sample cadence); fastEfficiency* are in days. Do not
// edit — any change requires re-running the certification in ALGO_PRODUCT.md
// and updating the risk contract.

import { fastStrategyFromConfig, FastStrategyConfig } from '#services/FastStrategy'

export interface DailyTrendProductRow {
  fastMomentumSeconds: number
  fastMomentumThresholdPct: number
  fastRsiLow: number
  fastRsiHigh: number
  fastStopLossPct: number
  fastTakeProfitPct: number
  fastExitReversalPct: number
  fastTrailingStopPct?: number | null
  fastTrailingActivatePct?: number | null
  fastMaxHoldSeconds?: number | null
  fastEmaPeriod?: number | null
  fastVolatilityWindowSeconds?: number | null
  fastVolatilityMult?: number | null
  fastVolatilityFloorPct?: number | null
  fastVolatilityCeilingPct?: number | null
  fastTrendMode?: boolean | number | null
  fastTrendSlopePct?: number | null
  fastTrendSlopeWindowSeconds?: number | null
  fastRegimeEmaPeriod?: number | null
  fastRegimeSlopeWindowSeconds?: number | null
  fastRegimeSlopeMinPct?: number | null
  fastVolumeWindowSeconds?: number | null
  fastVolumeMinRatio?: number | null
  fastTrailingVolatilityMult?: number | null
  fastScaleOutPct?: number | null
  fastHarVolForecast?: boolean | number | null
  fastCusumWindowSeconds?: number | null
  fastCusumExitPct?: number | null
  fastJumpSlackPct?: number | null
  fastChoppinessPeriod?: number | null
  fastChoppinessMax?: number | null
  fastTradeStartUtc?: number | null
  fastTradeEndUtc?: number | null
  fastEfficiencyWindowDays?: number | null
  fastEfficiencyMinPct?: number | null
  fastEfficiencyExitPct?: number | null
  fastConvictionSizing?: boolean | number | null
}

/** @internal structural mapping — keeps the row type honest. */
function toAlgoRowShape(row: DailyTrendProductRow): Parameters<typeof fastStrategyFromConfig>[0] {
  return row as Parameters<typeof fastStrategyFromConfig>[0]
}

export const DAILY_TREND_PRODUCT: DailyTrendProductRow = {
  // Burst-mode fields — unused in trend mode, kept explicit.
  fastMomentumSeconds: 900,
  fastMomentumThresholdPct: 0.3,
  fastRsiLow: 30,
  fastRsiHigh: 70,
  // Stops/exits.
  fastStopLossPct: 5,
  fastTakeProfitPct: 0,
  fastExitReversalPct: -99,
  fastTrailingStopPct: 12,
  fastTrailingActivatePct: 6,
  fastMaxHoldSeconds: 0,
  // Trend confirmation: price > EMA-1d, EMA rising >= 1.5%/3d.
  fastTrendMode: 1,
  fastEmaPeriod: 86_400, // 1 day
  fastTrendSlopePct: 1.5,
  fastTrendSlopeWindowSeconds: 259_200, // 3 days
  // Regime gate: 4d EMA rising >= 1.5%/7d.
  fastRegimeEmaPeriod: 345_600, // 4 days
  fastRegimeSlopeWindowSeconds: 604_800, // 7 days
  fastRegimeSlopeMinPct: 1.5,
  // Efficiency-ratio entry gate (chop blocker).
  fastEfficiencyWindowDays: 14,
  fastEfficiencyMinPct: 40,
  fastEfficiencyExitPct: 0, // exit-side variant rejected by evidence
  // Everything else off.
  fastVolatilityWindowSeconds: 0,
  fastVolatilityMult: 1,
  fastVolatilityFloorPct: 0.05,
  fastVolatilityCeilingPct: 0,
  fastHarVolForecast: 0,
  fastVolumeWindowSeconds: 0,
  fastVolumeMinRatio: 0,
  fastTrailingVolatilityMult: 0,
  fastScaleOutPct: 0,
  fastCusumWindowSeconds: 0,
  fastCusumExitPct: 0,
  fastJumpSlackPct: 0,
  fastChoppinessPeriod: 0,
  fastChoppinessMax: 0,
  fastTradeStartUtc: 0,
  fastTradeEndUtc: 24,
  fastConvictionSizing: 0,
}

/** Basket + execution constants from the risk contract. */
export const DAILY_TREND_PRODUCT_ASSETS = ['BTC', 'ETH', 'SOL'] as const

export const DAILY_TREND_PRODUCT_ENGINE = {
  feePct: 0.0026,
  slippageBps: 10,
  portfolioUsdPerAsset: 10_000,
  cooldownSeconds: 0,
}

/**
 * Strategy config for a given bar cadence (60 = 1m bars, 300 = 5m bars).
 */
export function dailyTrendStrategy(sampleIntervalSeconds: number): FastStrategyConfig {
  return fastStrategyFromConfig(toAlgoRowShape(DAILY_TREND_PRODUCT), { sampleIntervalSeconds })
}
