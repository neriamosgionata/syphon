// ─── Yield guard (fail-closed limits) ──────────────────────────
//
// Hard ceilings live in code, not only in configuration (R17). A config
// that is invalid or exceeds a ceiling refuses the whole tick before any
// venue call; per-asset and total USD caps trim the plan.

import type { PolicySkip, YieldAction, YieldPolicyConfig } from './YieldPolicy.js'

export const HARD_CEILINGS = {
  maxPerAssetUsd: 100_000,
  maxTotalUsd: 250_000,
  minBufferPct: 5,
  maxBufferPct: 90,
  maxMinAllocationUsd: 10_000,
  maxApyFloorPct: 50,
} as const

export interface YieldGuardConfig extends YieldPolicyConfig {
  /** Hard per-asset allocation cap in USD. */
  maxPerAssetUsd: number
  /** Hard total allocation cap in USD. */
  maxTotalUsd: number
}

export class YieldConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YieldConfigError'
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Throws YieldConfigError on any invalid or excessive value. */
export function validateYieldConfig(cfg: YieldGuardConfig): void {
  if (!Array.isArray(cfg.allowlist) || cfg.allowlist.length === 0) {
    throw new YieldConfigError('allowlist is empty')
  }
  if (!cfg.allowlist.every((asset) => typeof asset === 'string' && asset.length > 0)) {
    throw new YieldConfigError('allowlist contains an invalid asset')
  }
  if (!finite(cfg.bufferPct) || cfg.bufferPct < HARD_CEILINGS.minBufferPct || cfg.bufferPct > HARD_CEILINGS.maxBufferPct) {
    throw new YieldConfigError(`bufferPct out of range (${HARD_CEILINGS.minBufferPct}-${HARD_CEILINGS.maxBufferPct})`)
  }
  if (!finite(cfg.minAllocationUsd) || cfg.minAllocationUsd < 0 || cfg.minAllocationUsd > HARD_CEILINGS.maxMinAllocationUsd) {
    throw new YieldConfigError(`minAllocationUsd out of range (0-${HARD_CEILINGS.maxMinAllocationUsd})`)
  }
  if (!finite(cfg.apyFloorPct) || cfg.apyFloorPct < 0 || cfg.apyFloorPct > HARD_CEILINGS.maxApyFloorPct) {
    throw new YieldConfigError(`apyFloorPct out of range (0-${HARD_CEILINGS.maxApyFloorPct})`)
  }
  if (!finite(cfg.maxPerAssetUsd) || cfg.maxPerAssetUsd <= 0 || cfg.maxPerAssetUsd > HARD_CEILINGS.maxPerAssetUsd) {
    throw new YieldConfigError(`maxPerAssetUsd out of range (0-${HARD_CEILINGS.maxPerAssetUsd})`)
  }
  if (!finite(cfg.maxTotalUsd) || cfg.maxTotalUsd <= 0 || cfg.maxTotalUsd > HARD_CEILINGS.maxTotalUsd) {
    throw new YieldConfigError(`maxTotalUsd out of range (0-${HARD_CEILINGS.maxTotalUsd})`)
  }
  if (cfg.maxTotalUsd < cfg.maxPerAssetUsd) {
    throw new YieldConfigError('maxTotalUsd is below maxPerAssetUsd')
  }
}

export interface CapState {
  totalAllocatedUsd: number
  allocatedUsdByAsset: Record<string, number>
}

/** Drop actions that would break the per-asset or total USD caps. */
export function applyCaps(
  actions: YieldAction[],
  cfg: YieldGuardConfig,
  state: CapState
): { actions: YieldAction[]; skips: PolicySkip[] } {
  const kept: YieldAction[] = []
  const skips: PolicySkip[] = []
  let total = state.totalAllocatedUsd

  for (const action of actions) {
    const perAsset = (state.allocatedUsdByAsset[action.asset] ?? 0) + action.amountUsd
    if (perAsset > cfg.maxPerAssetUsd) {
      skips.push({ strategyId: action.strategyId, asset: action.asset, reason: 'cap-reached', detail: 'per-asset cap' })
      continue
    }
    if (total + action.amountUsd > cfg.maxTotalUsd) {
      skips.push({ strategyId: action.strategyId, asset: action.asset, reason: 'cap-reached', detail: 'total cap' })
      continue
    }
    kept.push(action)
    total += action.amountUsd
  }

  return { actions: kept, skips }
}
