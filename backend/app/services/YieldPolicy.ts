// ─── Yield policy (pure) ───────────────────────────────────────
//
// Decision math only, no I/O: given one venue strategy, the account's
// balances, a price, and the operator's limits, decide whether to allocate
// and how much — or why not. The service persists and executes the result.

export type YieldSkipReason =
  | 'not-allowlisted'
  | 'not-allocatable'
  | 'report-only'
  | 'pending-operation'
  | 'below-buffer'
  | 'below-minimum'
  | 'cap-reached'
  | 'apy-below-floor'
  | 'no-price'

export interface YieldPolicyConfig {
  /** Asset allowlist (upper-case symbols). */
  allowlist: string[]
  /** Per-asset liquid buffer as % of total balance. */
  bufferPct: number
  /** Absolute dust floor in USD; the effective minimum is the greater of this and the strategy minimum. */
  minAllocationUsd: number
  /** Stop new allocations when the strategy's low APY estimate is below this (% p.a.). */
  apyFloorPct: number
}

export interface PolicyStrategy {
  strategyId: string
  asset: string
  lockType: string
  canAllocate: boolean
  allocatedNative: number
  minAllocationUsd: number | null
  userCapUsd: number | null
  apyLow: number | null
}

export interface PolicyInput {
  strategy: PolicyStrategy
  /** Free balance in native units. */
  freeNative: number
  /** Total balance in native units (buffer base). */
  totalNative: number
  priceUsd: number | null
  hasPendingIntent: boolean
}

export interface YieldAction {
  strategyId: string
  asset: string
  lockType: string
  amountNative: number
  amountUsd: number
  priceUsd: number
}

export interface PolicySkip {
  strategyId: string
  asset: string
  reason: YieldSkipReason
  detail?: string
}

export interface PolicyDecision {
  action: YieldAction | null
  skip: PolicySkip | null
}

function round(value: number, decimals = 12): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Kraken balance codes: XXBT/XETH/ZUSD legacy prefixes; XBT means BTC. */
export function normalizeKrakenAsset(code: string): string {
  let out = code
  if (out.length === 4 && (out.startsWith('X') || out.startsWith('Z'))) out = out.slice(1)
  return out === 'XBT' ? 'BTC' : out
}

/** Native balance for a normalized asset symbol; null when the asset is absent. */
export function balanceNativeFor(balances: Record<string, string>, asset: string): number | null {
  for (const [code, value] of Object.entries(balances)) {
    if (normalizeKrakenAsset(code) === asset.toUpperCase()) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
  }
  return null
}

export { round }

function skip(input: PolicyInput, reason: YieldSkipReason, detail?: string): PolicyDecision {
  return {
    action: null,
    skip: { strategyId: input.strategy.strategyId, asset: input.strategy.asset, reason, detail },
  }
}

/**
 * Plan one strategy. Lock-type semantics follow the venue's own enum:
 * `flex` is the account-wide Auto Earn mode and is report-only, never
 * allocated (KTD3).
 */
export function planYieldAction(input: PolicyInput, cfg: YieldPolicyConfig): PolicyDecision {
  const { strategy } = input

  if (strategy.lockType === 'flex') return skip(input, 'report-only')
  if (!cfg.allowlist.includes(strategy.asset.toUpperCase())) return skip(input, 'not-allowlisted')
  if (!strategy.canAllocate) return skip(input, 'not-allocatable')
  if (input.hasPendingIntent) return skip(input, 'pending-operation')

  if (!input.priceUsd || !Number.isFinite(input.priceUsd) || input.priceUsd <= 0) {
    return skip(input, 'no-price')
  }
  if (strategy.apyLow !== null && strategy.apyLow * 100 < cfg.apyFloorPct) {
    return skip(input, 'apy-below-floor', `apy ${(strategy.apyLow * 100).toFixed(2)}%`)
  }

  // user_cap of 0 blocks new allocations (venue semantics).
  if (strategy.userCapUsd === 0) return skip(input, 'cap-reached', 'user cap is 0')

  const bufferNative = round(input.totalNative * (cfg.bufferPct / 100))
  let availableNative = round(input.freeNative - bufferNative)
  if (availableNative <= 0) return skip(input, 'below-buffer', `available ${availableNative}`)

  // The venue's minimum and cap are USD-denominated; convert with the
  // named price source and decide in USD, then size in native units.
  const minUsd = Math.max(strategy.minAllocationUsd ?? 0, cfg.minAllocationUsd)
  let availableUsd = round(availableNative * input.priceUsd)
  if (availableUsd < minUsd) {
    return skip(input, 'below-minimum', `$${availableUsd.toFixed(2)} < $${minUsd.toFixed(2)}`)
  }

  if (strategy.userCapUsd !== null && strategy.userCapUsd > 0) {
    const remainingUsd = round(strategy.userCapUsd - strategy.allocatedNative * input.priceUsd)
    if (remainingUsd <= 0) return skip(input, 'cap-reached')
    if (remainingUsd < availableUsd) {
      availableUsd = remainingUsd
      availableNative = round(remainingUsd / input.priceUsd)
    }
  }

  const amountNative = round(availableNative)
  if (amountNative <= 0) return skip(input, 'below-minimum', 'native amount rounds to zero')

  return {
    action: {
      strategyId: strategy.strategyId,
      asset: strategy.asset,
      lockType: strategy.lockType,
      amountNative,
      amountUsd: round(amountNative * input.priceUsd),
      priceUsd: input.priceUsd,
    },
    skip: null,
  }
}
