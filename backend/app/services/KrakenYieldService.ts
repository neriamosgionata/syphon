// ─── Kraken yield tick ─────────────────────────────────────────
//
// The hourly yield trigger: refresh strategies/allocations/balances,
// ingest ledger rewards, reconcile, adopt non-terminal intents, plan per
// asset with YieldPolicy/YieldGuard, then either observe (default) or
// allocate. Intent-first: every mutating request has an append-only row
// committed before it; ambiguous outcomes are never resubmitted.

import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import KrakenEarnClient, {
  KrakenEarnError,
  type EarnAllocation,
  type EarnLedgerEntry,
  type EarnLedgerQuery,
  type EarnOperationStatus,
  type EarnStrategy,
} from '#services/KrakenEarnClient'
import KrakenService from '#services/KrakenService'
import YieldAccounting, { isRewardLedgerType } from '#services/YieldAccounting'
import YieldAllocation from '#models/YieldAllocation'
import OperationIntent from '#models/OperationIntent'
import OperationAlert from '#models/OperationAlert'
import ControlRecord from '#models/ControlRecord'
import { normalizeKrakenAsset, planYieldAction, type PolicySkip, type YieldAction } from '#services/YieldPolicy'
import { applyCaps, validateYieldConfig, yieldConfigFromEnv, type YieldGuardConfig } from '#services/YieldGuard'
import {
  DEFAULT_PREFLIGHT_TTL_MS,
  PREFLIGHT_CONTROL_NAME,
  isPreflightFresh,
} from '#services/YieldPreflight'

const LOCK_NAME = 'yield:tick'
const REWARD_LOOKBACK_SECONDS = 7 * 86_400
const SUCCESS_STATUSES = ['success', 'settled', 'completed', 'done', 'ok']
const FAILED_STATUSES = ['error', 'failed', 'canceled', 'cancelled', 'rejected']

export interface EarnSurface {
  getStrategies(): Promise<EarnStrategy[]>
  getAllocations(): Promise<EarnAllocation[]>
  getBalance(): Promise<Record<string, string>>
  getLedgers(query?: EarnLedgerQuery): Promise<{ entries: EarnLedgerEntry[]; count: number }>
  allocate(strategyId: string, amount: number): Promise<{ refid: string | null }>
  deallocate(strategyId: string, amount: number): Promise<{ refid: string | null }>
  getAllocateStatus(refid: string): Promise<EarnOperationStatus>
  getDeallocateStatus(refid: string): Promise<EarnOperationStatus>
}

export interface YieldServiceOptions {
  earn?: EarnSurface
  accounting?: YieldAccounting
  price?: (asset: string) => Promise<number | null>
  now?: () => number
  live?: () => boolean
  sleep?: (ms: number) => Promise<unknown>
  pollIntervalMs?: number
  pollTimeoutMs?: number
  lockTtlMs?: number
  staleIntentMs?: number
  config?: () => YieldGuardConfig
  preflightTtlMs?: number
  owner?: string
}

export interface YieldTickResult {
  status: 'ok' | 'refused' | 'skipped' | 'failed'
  live?: boolean
  reason?: string
  actions?: YieldAction[]
  skips?: PolicySkip[]
  executed?: any[]
  rewardsIngested?: number
  adopted?: any[]
}

function round(value: number, decimals = 12): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export async function tickerPrice(asset: string): Promise<number | null> {
  try {
    const result = await KrakenService.getTicker(KrakenService.buildPair(asset))
    const row: any = result ? Object.values(result)[0] : null
    const last = Number(row?.c?.[0])
    return Number.isFinite(last) && last > 0 ? last : null
  } catch {
    return null
  }
}

/** Kraken balance codes: XXBT/XETH/ZUSD legacy prefixes; XBT means BTC. */
export { normalizeKrakenAsset }

class KrakenYieldService {
  private earn: EarnSurface
  private accounting: YieldAccounting
  private price: (asset: string) => Promise<number | null>
  private now: () => number
  private live: () => boolean
  private sleep: (ms: number) => Promise<unknown>
  private pollIntervalMs: number
  private pollTimeoutMs: number
  private lockTtlMs: number
  private staleIntentMs: number
  private config: () => YieldGuardConfig
  private owner: string
  private preflightTtlMs: number

  constructor(opts: YieldServiceOptions = {}) {
    this.earn = opts.earn ?? (KrakenEarnClient as EarnSurface)
    this.accounting = opts.accounting ?? YieldAccounting
    this.price = opts.price ?? tickerPrice
    this.now = opts.now ?? Date.now
    this.live = opts.live ?? (() => env.get('YIELD_LIVE', false) === true)
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000
    this.lockTtlMs = opts.lockTtlMs ?? 30 * 60 * 1000
    this.staleIntentMs = opts.staleIntentMs ?? 2 * 60 * 60 * 1000
    this.config = opts.config ?? yieldConfigFromEnv
    this.owner = opts.owner ?? `yield-tick-${process.pid}`
    this.preflightTtlMs = opts.preflightTtlMs ?? DEFAULT_PREFLIGHT_TTL_MS
  }

  public async tick(): Promise<YieldTickResult> {
    const cfg = this.config()
    try {
      validateYieldConfig(cfg)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.alert('critical', 'invalid-config', `yield configuration refused: ${message}`)
      return { status: 'refused', reason: message }
    }

    const acquired = await ControlRecord.tryAcquire(LOCK_NAME, this.owner, this.lockTtlMs, this.now())
    if (!acquired) return { status: 'skipped', reason: 'lock-held' }

    try {
      return await this.runTick(cfg)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.alert('critical', 'tick-failed', `yield tick failed: ${message}`)
      return { status: 'failed', reason: message }
    } finally {
      await ControlRecord.release(LOCK_NAME, this.owner)
    }
  }

  private async runTick(cfg: YieldGuardConfig): Promise<YieldTickResult> {
    const now = this.now()
    const live = this.live()

    // Live mutating calls require a fresh, recorded preflight pass (R4).
    if (live) {
      const preflight = await ControlRecord.get(PREFLIGHT_CONTROL_NAME)
      if (!isPreflightFresh(preflight, now, this.preflightTtlMs)) {
        await this.alert('critical', 'preflight-required', 'live tick refused: no fresh passing preflight')
        return { status: 'refused', reason: 'preflight-required' }
      }
    }

    const strategies = await this.earn.getStrategies()
    const allocations = await this.earn.getAllocations()
    const balances = await this.earn.getBalance()

    const byStrategy = new Map(allocations.map((allocation) => [allocation.strategyId, allocation]))
    for (const strategy of strategies) {
      const allocation = byStrategy.get(strategy.strategyId)
      await this.accounting.upsertAllocation(
        {
          strategyId: strategy.strategyId,
          asset: strategy.asset,
          lockType: strategy.lockType,
          canAllocate: strategy.canAllocate,
          autoCompound: strategy.autoCompound,
          allocatedNative: allocation?.allocatedNative ?? 0,
          pendingNative: allocation?.pendingNative ?? 0,
          unbondingNative: allocation?.unbondingNative ?? 0,
          exitQueueNative: allocation?.exitQueueNative ?? 0,
          totalRewardedNative: allocation?.totalRewardedNative ?? 0,
          unbondingSeconds: strategy.unbondingSeconds,
          minAllocationUsd: strategy.minAllocationUsd,
          userCapUsd: strategy.userCapUsd,
          apyLow: strategy.apyLow ?? allocation?.apyLow ?? null,
          apyHigh: strategy.apyHigh ?? allocation?.apyHigh ?? null,
        },
        now
      )
    }

    // A strategy that disappears while funds are allocated must alert.
    for (const row of await YieldAllocation.all()) {
      if (!strategies.some((strategy) => strategy.strategyId === row.strategyId)) {
        await this.alertOnce(
          'warning',
          'strategy-missing',
          `strategy ${row.strategyId} (${row.asset}) absent from the venue response`
        )
      }
    }

    const rewardsIngested = await this.ingestRewards(now)
    await this.reconcileRewards(allocations)
    const adopted = await this.adoptIntents(now, allocations)

    const prices = new Map<string, number | null>()
    const priceFor = async (asset: string): Promise<number | null> => {
      if (!prices.has(asset)) prices.set(asset, await this.price(asset))
      return prices.get(asset) ?? null
    }

    const nonTerminal = await OperationIntent.query().whereIn('status', ['pending', 'submitted'])
    const pendingStrategies = new Set(nonTerminal.map((intent) => intent.strategyId))

    const planned: YieldAction[] = []
    const skips: PolicySkip[] = []
    for (const strategy of strategies) {
      const allocation = byStrategy.get(strategy.strategyId)
      const totalNative = this.balanceFor(balances, strategy.asset)
      const decision = planYieldAction(
        {
          strategy: {
            strategyId: strategy.strategyId,
            asset: strategy.asset,
            lockType: strategy.lockType,
            canAllocate: strategy.canAllocate,
            allocatedNative: allocation?.allocatedNative ?? 0,
            minAllocationUsd: strategy.minAllocationUsd,
            userCapUsd: strategy.userCapUsd,
            apyLow: strategy.apyLow,
          },
          freeNative: totalNative,
          totalNative,
          priceUsd: await priceFor(strategy.asset),
          hasPendingIntent: pendingStrategies.has(strategy.strategyId),
        },
        cfg
      )
      if (decision.action) planned.push(decision.action)
      if (decision.skip) skips.push(decision.skip)
    }

    const capState = {
      totalAllocatedUsd: 0,
      allocatedUsdByAsset: {} as Record<string, number>,
    }
    for (const strategy of strategies) {
      const allocation = byStrategy.get(strategy.strategyId)
      if (!allocation || allocation.allocatedNative <= 0) continue
      const priceUsd = await priceFor(strategy.asset)
      if (!priceUsd) continue
      const usd = allocation.allocatedNative * priceUsd
      capState.totalAllocatedUsd += usd
      capState.allocatedUsdByAsset[strategy.asset] = (capState.allocatedUsdByAsset[strategy.asset] ?? 0) + usd
    }
    const capped = applyCaps(planned, cfg, capState)

    const executed = live ? await this.executePlan(capped.actions) : []

    await ControlRecord.heartbeat(LOCK_NAME, this.owner, now, {
      live,
      strategies: strategies.length,
      planned: capped.actions.length,
      executed: executed.length,
      skips: [...skips, ...capped.skips],
      rewardsIngested,
      adopted,
    })

    return {
      status: 'ok',
      live,
      actions: capped.actions,
      skips: [...skips, ...capped.skips],
      executed,
      rewardsIngested,
      adopted,
    }
  }

  /** Ledger ingestion: insert-only, dedup on refid, fail-open with an alert. */
  private async ingestRewards(now: number): Promise<number> {
    try {
      const { entries } = await this.earn.getLedgers({
        start: Math.floor(now / 1000) - REWARD_LOOKBACK_SECONDS,
      })
      const rewards = entries.filter(
        (entry) => isRewardLedgerType(entry.ledgerType) || entry.subtype === 'reward'
      )
      return await this.accounting.ingestRewards(rewards, null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.alertOnce('warning', 'ledger-failed', `ledger fetch failed: ${message}`)
      return 0
    }
  }

  private async reconcileRewards(allocations: EarnAllocation[]): Promise<void> {
    for (const allocation of allocations) {
      try {
        const result = await this.accounting.reconcileVenue(
          allocation.strategyId,
          allocation.totalRewardedNative
        )
        if (!result.ok) {
          await this.alertOnce(
            'warning',
            'reconcile-mismatch',
            `strategy ${allocation.strategyId} local rewards differ from the venue ledger`
          )
        }
      } catch {
        // Missing local row is handled by the refresh loop above.
      }
    }
  }

  /**
   * Non-terminal intents are adopted (resolved from the venue) or escalated.
   * They are never resubmitted: a strategy with a non-terminal intent is
   * skipped by the planner.
   */
  private async adoptIntents(now: number, allocations: EarnAllocation[]): Promise<any[]> {
    const rows = await OperationIntent.query().whereIn('status', ['pending', 'submitted'])
    const adopted: any[] = []

    for (const intent of rows) {
      const age = now - intent.createdAt

      if (intent.refid) {
        const terminal = await this.pollOnce(intent.type, intent.refid)
        if (terminal === 'success' || terminal === 'failed') {
          intent.status = terminal
          intent.terminalAt = now
          await intent.save()
          if (terminal === 'failed') {
            await this.alert('critical', 'allocation-failed', `operation ${intent.id} reported failure by the venue`)
          }
          adopted.push({ intentId: intent.id, status: terminal })
        } else if (age > this.staleIntentMs) {
          await this.alertOnce(
            'warning',
            'intent-stale',
            `operation ${intent.id} still non-terminal after ${Math.round(age / 60_000)}m`
          )
          adopted.push({ intentId: intent.id, status: 'escalated' })
        }
        continue
      }

      // No venue reference: a crash may have happened before or during the
      // request. Adopt when the venue state proves the allocation landed.
      const venue = allocations.find((allocation) => allocation.strategyId === intent.strategyId)
      if (
        intent.type === 'allocate' &&
        venue &&
        intent.amountNative !== null &&
        venue.allocatedNative >= intent.amountNative
      ) {
        intent.status = 'success'
        intent.terminalAt = now
        await intent.save()
        adopted.push({ intentId: intent.id, status: 'adopted' })
        continue
      }

      if (age > this.staleIntentMs) {
        await this.alertOnce(
          'warning',
          'ambiguous-intent',
          `operation ${intent.id} (${intent.type}) has no venue reference after ${Math.round(age / 60_000)}m — manual review`
        )
        adopted.push({ intentId: intent.id, status: 'escalated' })
      }
    }

    return adopted
  }

  private async executePlan(actions: YieldAction[]): Promise<any[]> {
    const results: any[] = []
    for (const action of actions) {
      const existing = await OperationIntent.query()
        .where('strategy_id', action.strategyId)
        .whereIn('status', ['pending', 'submitted'])
        .first()
      if (existing) {
        results.push({ strategyId: action.strategyId, skipped: 'pending-operation' })
        continue
      }
      results.push(await this.runOperation('allocate', action))
    }
    return results
  }

  /** Intent-first mutating call: append the intent, then submit, then poll to terminal. */
  private async runOperation(type: 'allocate' | 'deallocate', input: Omit<YieldAction, 'lockType'>) {
    const intent = await OperationIntent.create({
      strategyId: input.strategyId,
      asset: input.asset,
      type,
      status: 'pending',
      amountNative: input.amountNative,
      amountUsd: input.amountUsd,
      priceUsd: input.priceUsd,
      refid: null,
      error: null,
      createdAt: this.now(),
      submittedAt: null,
      terminalAt: null,
    })

    let refid: string | null = null
    try {
      const result =
        type === 'allocate'
          ? await this.earn.allocate(input.strategyId, input.amountNative)
          : await this.earn.deallocate(input.strategyId, input.amountNative)
      refid = result.refid
      intent.status = 'submitted'
      intent.refid = refid
      intent.submittedAt = this.now()
      await intent.save()
    } catch (error) {
      const code = error instanceof KrakenEarnError ? error.code : 'unknown'
      const message = error instanceof Error ? error.message : String(error)

      if (code === 'transport') {
        // Unknown outcome: never resubmit within the tick.
        intent.error = 'ambiguous transport failure'
        await intent.save()
        await this.alert('warning', 'ambiguous-allocation', `${type} outcome unknown for strategy ${input.strategyId}`)
      } else {
        intent.status = 'failed'
        intent.error = message.slice(0, 255)
        intent.terminalAt = this.now()
        await intent.save()
        await this.alert('critical', 'allocation-failed', `${type} failed for strategy ${input.strategyId}: ${message}`)
      }
      return { strategyId: input.strategyId, intentId: intent.id, status: intent.status }
    }

    if (!refid) {
      await this.alertOnce('warning', 'allocation-unknown', `${type} for strategy ${input.strategyId} returned no reference`)
      return { strategyId: input.strategyId, intentId: intent.id, status: intent.status }
    }

    const terminal = await this.pollOperation(type, refid)
    if (terminal === 'success') {
      intent.status = 'success'
      intent.terminalAt = this.now()
      await intent.save()
    } else if (terminal === 'failed') {
      intent.status = 'failed'
      intent.error = 'venue reported failure'
      intent.terminalAt = this.now()
      await intent.save()
      await this.alert('critical', 'allocation-failed', `${type} for strategy ${input.strategyId} reported failure`)
    } else {
      await this.alertOnce('warning', 'allocation-unknown', `${type} for strategy ${input.strategyId} still pending`)
    }

    return { strategyId: input.strategyId, intentId: intent.id, status: intent.status }
  }

  /** CLI-only deallocation path (the escape hatch) sharing the intent machinery. */
  public async deallocate(strategyId: string, amountNative: number, priceUsd: number | null = null) {
    const allocation = await YieldAllocation.query().where('strategy_id', strategyId).first()
    const asset = allocation?.asset ?? 'UNKNOWN'
    const price = priceUsd ?? (await this.price(asset))
    return this.runOperation('deallocate', {
      strategyId,
      asset,
      amountNative: round(amountNative),
      amountUsd: price ? round(amountNative * price) : 0,
      priceUsd: price ?? 0,
    })
  }

  private async pollOperation(type: 'allocate' | 'deallocate', refid: string): Promise<string> {
    const attempts = Math.max(1, Math.ceil(this.pollTimeoutMs / this.pollIntervalMs))
    for (let attempt = 0; attempt < attempts; attempt++) {
      const terminal = await this.pollOnce(type, refid)
      if (terminal) return terminal
      if (attempt < attempts - 1) await this.sleep(this.pollIntervalMs)
    }
    return 'unknown'
  }

  private async pollOnce(type: 'allocate' | 'deallocate', refid: string): Promise<'success' | 'failed' | null> {
    try {
      const status =
        type === 'allocate'
          ? await this.earn.getAllocateStatus(refid)
          : await this.earn.getDeallocateStatus(refid)
      const normalized = status.status.toLowerCase()
      if (SUCCESS_STATUSES.includes(normalized)) return 'success'
      if (FAILED_STATUSES.includes(normalized)) return 'failed'
      return null
    } catch {
      return null
    }
  }

  private balanceFor(balances: Record<string, string>, asset: string): number {
    for (const [code, value] of Object.entries(balances)) {
      if (normalizeKrakenAsset(code) === asset) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : 0
      }
    }
    return 0
  }

  private async alert(severity: string, code: string, message: string): Promise<void> {
    await OperationAlert.raise({ source: 'yield', severity, code, message, now: this.now() })
    logger.warn(`[Yield] ${severity}: ${code}: ${message}`)
  }

  /** Alert once per unresolved occurrence: repeated ticks do not spam. */
  private async alertOnce(severity: string, code: string, message: string): Promise<void> {
    const existing = await OperationAlert.query()
      .whereNull('acknowledged_at')
      .where('code', code)
      .where('message', message.slice(0, 512))
      .first()
    if (existing) return
    await this.alert(severity, code, message)
  }
}

export default new KrakenYieldService()
export { KrakenYieldService }
