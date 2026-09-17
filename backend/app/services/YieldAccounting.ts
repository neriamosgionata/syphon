import logger from '@adonisjs/core/services/logger'
import YieldAllocation from '#models/YieldAllocation'
import YieldReward from '#models/YieldReward'

// Yield accounting owns the payout record: Kraken's ledger is the source of
// truth, local rows are a projection of it, and reconciliation compares
// post-baseline deltas rather than lifetime totals.

export const REWARD_LEDGER_TYPES = ['staking', 'reward', 'earn'] as const

export function isRewardLedgerType(type: string): boolean {
  return (REWARD_LEDGER_TYPES as readonly string[]).includes(type)
}

export interface VenueAllocation {
  strategyId: string
  asset: string
  lockType: string
  canAllocate: boolean
  autoCompound?: string | null
  allocatedNative?: number
  pendingNative?: number
  unbondingNative?: number
  exitQueueNative?: number
  totalRewardedNative?: number
  unbondingSeconds?: number | null
  minAllocationUsd?: number | null
  userCapUsd?: number | null
  apyLow?: number | null
  apyHigh?: number | null
}

export interface LedgerReward {
  refid: string
  time: number
  ledgerType: string
  subtype?: string | null
  asset: string
  amount: number
  balanceAfter?: number | null
}

export interface ReconciliationResult {
  ok: boolean
  localSum: number
  venueDelta: number
  delta: number
  tolerance: number
}

export interface ReallocationCandidate {
  asset: string
  amount: number
  rewards: number
}

function round(value: number, decimals = 12): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function isRewardRow(row: YieldReward): boolean {
  return isRewardLedgerType(row.ledgerType) || row.subtype === 'reward'
}

export class YieldAccounting {
  /** Insert or refresh one strategy row. A new row freezes its reward baseline. */
  public async upsertAllocation(input: VenueAllocation, now: number = Date.now()): Promise<YieldAllocation> {
    const existing = await YieldAllocation.query().where('strategy_id', input.strategyId).first()
    const row = existing ?? new YieldAllocation()
    if (!existing) {
      row.strategyId = input.strategyId
      row.baselineRewardedNative = input.totalRewardedNative ?? 0
      row.baselineAt = now
    }
    row.asset = input.asset
    row.lockType = input.lockType
    row.canAllocate = input.canAllocate
    row.autoCompound = input.autoCompound ?? null
    row.allocatedNative = input.allocatedNative ?? row.allocatedNative ?? 0
    row.pendingNative = input.pendingNative ?? row.pendingNative ?? 0
    row.unbondingNative = input.unbondingNative ?? row.unbondingNative ?? 0
    row.exitQueueNative = input.exitQueueNative ?? row.exitQueueNative ?? 0
    row.totalRewardedNative = input.totalRewardedNative ?? row.totalRewardedNative ?? 0
    row.unbondingSeconds = input.unbondingSeconds ?? row.unbondingSeconds ?? null
    row.minAllocationUsd = input.minAllocationUsd ?? row.minAllocationUsd ?? null
    row.userCapUsd = input.userCapUsd ?? row.userCapUsd ?? null
    row.apyLow = input.apyLow ?? row.apyLow ?? null
    row.apyHigh = input.apyHigh ?? row.apyHigh ?? null
    row.lastRefreshedAt = now
    await row.save()
    return row
  }

  /** Re-freeze the reward baseline at the strategy's current lifetime total. */
  public async setBaseline(strategyId: string, now: number = Date.now()): Promise<YieldAllocation | null> {
    const row = await YieldAllocation.query().where('strategy_id', strategyId).first()
    if (!row) return null
    row.baselineRewardedNative = row.totalRewardedNative
    row.baselineAt = now
    await row.save()
    return row
  }

  /**
   * Store ledger reward events, insert-only and deduplicated on the venue's
   * refid. Unknown ledger types are stored too: the venue's type vocabulary
   * conflicts across its own docs, so classification happens at report time.
   */
  public async ingestRewards(entries: LedgerReward[], strategyId: string | null = null): Promise<number> {
    if (entries.length === 0) return 0
    const refids = entries.map((entry) => entry.refid)
    const existing = await YieldReward.query().whereIn('refid', refids).select('refid')
    const seen = new Set(existing.map((row) => row.refid))
    const fresh = entries.filter((entry) => !seen.has(entry.refid))
    if (fresh.length === 0) return 0
    await YieldReward.createMany(
      fresh.map((entry) => ({
        refid: entry.refid,
        time: entry.time,
        ledgerType: entry.ledgerType,
        subtype: entry.subtype ?? null,
        asset: entry.asset,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter ?? null,
        strategyId,
      }))
    )
    return fresh.length
  }

  public async rewardsForAsset(asset: string, fromMs: number, toMs: number = Date.now()): Promise<YieldReward[]> {
    const rows = await YieldReward.query()
      .where('asset', asset)
      .where('time', '>=', fromMs)
      .where('time', '<=', toMs)
      .orderBy('time', 'asc')
    return rows.filter(isRewardRow)
  }

  /**
   * Compare local post-baseline rewards for a strategy's asset against the
   * venue's post-baseline rewarded delta. Float64 storage makes the tolerance
   * relative, floored at the asset's precision.
   */
  public async reconcileVenue(
    strategyId: string,
    venueTotalRewardedNative: number,
    toleranceRelative = 1e-6,
    absoluteFloor = 1e-9
  ): Promise<ReconciliationResult> {
    const allocation = await YieldAllocation.query().where('strategy_id', strategyId).first()
    if (!allocation) {
      throw new Error(`no allocation row for strategy ${strategyId}`)
    }
    const venueDelta = round(venueTotalRewardedNative - allocation.baselineRewardedNative)
    const fromMs = allocation.baselineAt ?? 0
    const rewards = await this.rewardsForAsset(allocation.asset, fromMs)
    const localSum = round(rewards.reduce((sum, row) => sum + row.amount, 0))
    const delta = round(localSum - venueDelta)
    const tolerance = Math.max(Math.abs(venueDelta) * toleranceRelative, absoluteFloor)
    const ok = Math.abs(delta) <= tolerance
    if (!ok) {
      logger.warn(
        `[YieldAccounting] reconciliation mismatch for ${strategyId}: local ${localSum} vs venue delta ${venueDelta}`
      )
    }
    return { ok, localSum, venueDelta, delta, tolerance }
  }

  /** Realized rewards per asset since a cursor, ignoring dust below precision. */
  public async realizedByAsset(fromMs: number, toMs = Date.now(), decimalsByAsset: Record<string, number> = {}) {
    const rows = (await YieldReward.query()
      .where('time', '>=', fromMs)
      .where('time', '<=', toMs)
      .orderBy('time', 'asc')
    ).filter(isRewardRow)

    const totals = new Map<string, { amount: number; rewards: number }>()
    for (const row of rows) {
      const decimals = decimalsByAsset[row.asset]
      if (decimals !== undefined && row.amount < 10 ** -decimals) continue
      const current = totals.get(row.asset) ?? { amount: 0, rewards: 0 }
      current.amount = round(current.amount + row.amount)
      current.rewards += 1
      totals.set(row.asset, current)
    }
    return [...totals.entries()].map(([asset, value]) => ({ asset, ...value }))
  }

  /** Assets whose realized rewards qualify for re-allocation, by precision floor. */
  public async reallocationCandidates(
    fromMs: number,
    decimalsByAsset: Record<string, number>
  ): Promise<ReallocationCandidate[]> {
    const realized = await this.realizedByAsset(fromMs, Date.now(), decimalsByAsset)
    return realized
      .map((entry) => ({ asset: entry.asset, amount: entry.amount, rewards: entry.rewards }))
      .filter((entry) => entry.amount > 0)
  }
}

export default new YieldAccounting()
