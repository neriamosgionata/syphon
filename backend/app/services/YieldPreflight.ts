// ─── Yield preflight ───────────────────────────────────────────
//
// A live mutating tick is only allowed after a fresh, recorded preflight
// pass (R4). Preflight audits three layers and refuses on any failure:
// local state, venue state, and the operator environment. It never calls
// a mutating venue endpoint.

import fs from 'node:fs'
import { execSync } from 'node:child_process'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import KrakenEarnClient, { KrakenEarnError } from '#services/KrakenEarnClient'
import type { EarnAllocation, EarnStrategy } from '#services/KrakenEarnClient'
import type { EarnSurface } from '#services/KrakenYieldService'
import YieldAllocation from '#models/YieldAllocation'
import OperationIntent from '#models/OperationIntent'
import OperationAlert from '#models/OperationAlert'
import ControlRecord from '#models/ControlRecord'
import { balanceNativeFor, planYieldAction } from '#services/YieldPolicy'
import { isLoopbackHost } from '#services/income_bind_guard'
import { validateYieldConfig, yieldConfigFromEnv, type YieldGuardConfig } from '#services/YieldGuard'

export const PREFLIGHT_CONTROL_NAME = 'yield:preflight'
export const DEFAULT_PREFLIGHT_TTL_MS = 60 * 60 * 1000
export const ONE_TICK_MS = 60 * 60 * 1000

const KEY_MATERIAL_PATTERNS = [/KRAKEN_EARN_KEY\s*=/, /KRAKEN_EARN_SECRET\s*=/, /API-Sign/]
const LOG_TAIL_BYTES = 256 * 1024

export interface PreflightCheck {
  layer: 'local' | 'venue' | 'environment'
  name: string
  ok: boolean
  detail?: string
}

export interface PreflightResult {
  passed: boolean
  checks: PreflightCheck[]
  failed: string[]
}

export interface PreflightOptions {
  earn?: EarnSurface
  config?: YieldGuardConfig
  host?: string
  now?: number
  envFilePath?: string
  fastAlgoSessionActive?: boolean
  crontabText?: string | null
  logFile?: string | null
  price?: (asset: string) => Promise<number | null>
}

export function isPreflightFresh(row: ControlRecord | null, now: number, ttlMs: number): boolean {
  if (!row || row.state !== 'passed' || row.heartbeatAt === null || row.heartbeatAt === undefined) return false
  return now - row.heartbeatAt <= ttlMs
}

export async function recordPreflightPass(
  result: PreflightResult,
  now = Date.now()
): Promise<void> {
  await ControlRecord.setState(
    PREFLIGHT_CONTROL_NAME,
    result.passed ? 'passed' : 'failed',
    { passed: result.passed, failed: result.failed, at: now },
    { heartbeatAt: now }
  )
}

function readCrontab(): string | null {
  try {
    return execSync('crontab -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function readLogTail(file: string, bytes: number): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export async function runPreflight(opts: PreflightOptions = {}): Promise<PreflightResult> {
  const now = opts.now ?? Date.now()
  const cfg = opts.config ?? yieldConfigFromEnv()
  const earn = opts.earn ?? (KrakenEarnClient as EarnSurface)
  const checks: PreflightCheck[] = []

  const push = (layer: PreflightCheck['layer'], name: string, ok: boolean, detail?: string) =>
    checks.push({ layer, name, ok, detail })

  // ── Local state ───────────────────────────────────────────────
  const duplicates = await db
    .from('yield_allocations')
    .select('strategy_id')
    .groupBy('strategy_id')
    .havingRaw('count(*) > 1')
  push('local', 'unique-strategy-rows', duplicates.length === 0, duplicates.length ? `${duplicates.length} duplicated` : undefined)

  const intents = await OperationIntent.all()
  const rows = await YieldAllocation.all()
  const knownStrategies = new Set(rows.map((row) => row.strategyId))
  const orphans = intents.filter((intent) => !knownStrategies.has(intent.strategyId))
  push('local', 'no-orphan-intents', orphans.length === 0, orphans.length ? `${orphans.length} orphaned` : undefined)

  const staleOperations = intents.filter((intent) => !intent.terminal && now - intent.createdAt > ONE_TICK_MS)
  push(
    'local',
    'no-stale-operations',
    staleOperations.length === 0,
    staleOperations.length ? `${staleOperations.length} older than one tick` : undefined
  )

  const heartbeatStale = await ControlRecord.isStale('yield:tick', now, 2 * ONE_TICK_MS)
  push('local', 'heartbeat-fresh', !heartbeatStale, heartbeatStale ? 'yield:tick heartbeat stale or absent' : undefined)

  const unacknowledged = await OperationAlert.unacknowledged('yield')
  push(
    'local',
    'no-unacknowledged-alerts',
    unacknowledged.length === 0,
    unacknowledged.length ? `${unacknowledged.length} unacknowledged` : undefined
  )

  // ── Venue state ───────────────────────────────────────────────
  let strategies: EarnStrategy[] = []
  let allocations: EarnAllocation[] = []
  let venueReadable = true

  try {
    strategies = await earn.getStrategies()
    push('venue', 'key-permission', true)
  } catch (error) {
    venueReadable = false
    const code = error instanceof KrakenEarnError ? error.code : 'unknown'
    push('venue', 'key-permission', false, `Strategies refused (${code})`)
  }

  if (venueReadable) {
    try {
      allocations = await earn.getAllocations()
      push('venue', 'allocations-readable', true)
    } catch (error) {
      const code = error instanceof KrakenEarnError ? error.code : 'unknown'
      push('venue', 'allocations-readable', false, `Allocations refused (${code})`)
    }

    let balances: Record<string, string> = {}
    try {
      balances = await earn.getBalance()
      push('venue', 'funds-readable', true)
    } catch (error) {
      const code = error instanceof KrakenEarnError ? error.code : 'unknown'
      push('venue', 'funds-readable', false, `Balance refused (${code})`)
    }

    const allowlisted = strategies.filter((strategy) => cfg.allowlist.includes(strategy.asset.toUpperCase()))
    const eligible = allowlisted.filter((strategy) => strategy.canAllocate && strategy.lockType !== 'flex')
    push(
      'venue',
      'allowlist-eligible',
      eligible.length > 0,
      eligible.length === 0 ? 'no allowlisted, allocatable strategy at the venue' : undefined
    )

    const pendingVenue = allocations.filter((allocation) => allocation.pendingNative > 0)
    push(
      'venue',
      'no-pending-venue-operations',
      pendingVenue.length === 0,
      pendingVenue.length ? `${pendingVenue.length} pending at the venue` : undefined
    )

    const outOfBand = eligible.filter(
      (strategy) =>
        strategy.apyLow !== null &&
        (strategy.apyLow * 100 < cfg.apyFloorPct || strategy.apyLow * 100 > cfg.apyCeilingPct)
    )
    push(
      'venue',
      'apy-in-band',
      outOfBand.length === 0,
      outOfBand.length ? `${outOfBand.length} outside ${cfg.apyFloorPct}-${cfg.apyCeilingPct}%` : undefined
    )

    // Capacity report: decisions must be computable (a price failure is a
    // real problem; "nothing to allocate right now" is not).
    const priceFn = opts.price ?? (async () => null)
    let priceFailures = 0
    let capacity = 0
    for (const strategy of eligible) {
      const native = balanceNativeFor(balances, strategy.asset) ?? 0
      const decision = planYieldAction(
        {
          strategy: {
            strategyId: strategy.strategyId,
            asset: strategy.asset,
            lockType: strategy.lockType,
            canAllocate: strategy.canAllocate,
            allocatedNative: 0,
            minAllocationUsd: strategy.minAllocationUsd,
            userCapUsd: strategy.userCapUsd,
            apyLow: strategy.apyLow,
          },
          freeNative: native,
          totalNative: native,
          priceUsd: await priceFn(strategy.asset),
          hasPendingIntent: false,
        },
        cfg
      )
      if (decision.skip?.reason === 'no-price') priceFailures++
      if (decision.action) capacity++
    }
    push('venue', 'price-source-works', priceFailures === 0, priceFailures ? `${priceFailures} unpriced` : undefined)
    push('venue', 'capacity-reported', true, `${capacity} allocatable asset(s) right now`)
  }

  // ── Environment ───────────────────────────────────────────────
  const host = opts.host ?? env.get('HOST', '')
  push('environment', 'loopback-bind', isLoopbackHost(host), `HOST=${host || '(unset)'}`)

  const envFile = opts.envFilePath ?? `${process.cwd()}/.env`
  try {
    const mode = fs.statSync(envFile).mode & 0o777
    push(
      'environment',
      'secret-file-permissions',
      (mode & 0o077) === 0,
      (mode & 0o077) === 0 ? undefined : `.env mode ${mode.toString(8)} is group/world accessible`
    )
  } catch {
    push('environment', 'secret-file-permissions', true, '.env not present')
  }

  try {
    validateYieldConfig(cfg)
    push('environment', 'sane-ceilings', true)
  } catch (error) {
    push('environment', 'sane-ceilings', false, error instanceof Error ? error.message : String(error))
  }

  const crontab = opts.crontabText === undefined ? readCrontab() : opts.crontabText
  if (crontab === null) {
    push('environment', 'single-yield-trigger', true, 'crontab unavailable — verify the schedule manually')
  } else {
    const triggers = crontab
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .filter((line) => /yield:tick/.test(line))
    push(
      'environment',
      'single-yield-trigger',
      triggers.length <= 1,
      triggers.length > 1 ? `${triggers.length} yield:tick entries in crontab` : undefined
    )
  }

  push(
    'environment',
    'single-signer',
    !opts.fastAlgoSessionActive,
    opts.fastAlgoSessionActive ? 'an active fast-algo Kraken session shares signing state' : undefined
  )

  const logFile = opts.logFile === undefined ? `${process.cwd()}/logs/syphon.log` : opts.logFile
  const tail = logFile ? readLogTail(logFile, LOG_TAIL_BYTES) : null
  if (tail === null) {
    push('environment', 'no-key-material-in-logs', true, 'no local log file to scan')
  } else {
    const leaking = KEY_MATERIAL_PATTERNS.some((pattern) => pattern.test(tail))
    push('environment', 'no-key-material-in-logs', !leaking, leaking ? 'log tail contains key material patterns' : undefined)
  }

  const failed = checks.filter((check) => !check.ok).map((check) => check.name)
  return { passed: failed.length === 0, checks, failed }
}
