import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '@japa/runner'
import { KrakenYieldService } from '../../app/services/KrakenYieldService.js'
import {
  recordPreflightPass,
  runPreflight,
  type PreflightOptions,
} from '../../app/services/YieldPreflight.js'
import { buildYieldReportCsv, buildYieldStatus } from '../../app/services/YieldReport.js'
import { KrakenEarnError } from '../../app/services/KrakenEarnClient.js'
import OperationIntent from '../../app/models/OperationIntent.js'
import OperationAlert from '../../app/models/OperationAlert.js'
import ControlRecord from '../../app/models/ControlRecord.js'
import YieldAllocation from '../../app/models/YieldAllocation.js'
import YieldReward from '../../app/models/YieldReward.js'

// Yield commands surface: preflight layers, the live-tick preflight gate,
// status staleness/alerts, acknowledgment, and the reward CSV export.

const BASE_NOW = Date.now()

const BASE_CFG = {
  allowlist: ['ETH'],
  bufferPct: 25,
  minAllocationUsd: 10,
  apyFloorPct: 0.5,
  apyCeilingPct: 5,
  maxPerAssetUsd: 10_000,
  maxTotalUsd: 20_000,
}

function strategy(overrides: Record<string, any> = {}) {
  return {
    strategyId: 'ES-ETH-1',
    asset: 'ETH',
    lockType: 'instant',
    canAllocate: true,
    autoCompound: 'enabled',
    minAllocationUsd: 0,
    userCapUsd: 1000,
    apyLow: 0.03,
    apyHigh: 0.05,
    unbondingSeconds: null,
    ...overrides,
  }
}

function allocation(overrides: Record<string, any> = {}) {
  return {
    strategyId: 'ES-ETH-1',
    asset: 'ETH',
    lockType: 'instant',
    canAllocate: true,
    autoCompound: 'enabled',
    allocatedNative: 0,
    pendingNative: 0,
    unbondingNative: 0,
    exitQueueNative: 0,
    totalRewardedNative: 0,
    minAllocationUsd: 0,
    userCapUsd: 1000,
    apyLow: 0.03,
    apyHigh: 0.05,
    unbondingSeconds: null,
    ...overrides,
  }
}

function fakeEarn(overrides: Record<string, any> = {}) {
  const state: any = {
    strategies: [strategy()],
    allocations: [allocation()],
    balances: { XETH: '2' },
    allocateCalls: [],
    ...overrides,
  }
  const earn = {
    getStrategies: async () => state.strategies,
    getAllocations: async () => state.allocations,
    getBalance: async () => state.balances,
    getLedgers: async () => ({ entries: [], count: 0 }),
    allocate: async (strategyId: string, amount: number) => {
      state.allocateCalls.push({ strategyId, amount })
      return { refid: 'REF-1' }
    },
    deallocate: async () => ({ refid: 'DREF-1' }),
    getAllocateStatus: async (refid: string) => ({ refid, status: 'success', strategyId: null, amount: null, error: null }),
    getDeallocateStatus: async (refid: string) => ({ refid, status: 'success', strategyId: null, amount: null, error: null }),
  }
  return { earn, state }
}

async function markTickHeartbeat(now = BASE_NOW) {
  await ControlRecord.tryAcquire('yield:tick', 'test', 60_000, now)
  await ControlRecord.release('yield:tick', 'test')
}

function preflightOptions(earn: any, overrides: Partial<PreflightOptions> = {}): PreflightOptions {
  return {
    earn,
    config: BASE_CFG,
    host: '127.0.0.1',
    now: BASE_NOW,
    envFilePath: '/tmp/syphon-nonexistent-env-file',
    crontabText: '0 * * * * cd /app && bun ace.js yield:tick >> log',
    logFile: null,
    fastAlgoSessionActive: false,
    price: async () => 100,
    ...overrides,
  }
}

test.group('YieldPreflight', (group) => {
  group.each.setup(async () => {
    await OperationAlert.query().delete()
    await OperationIntent.query().delete()
    await ControlRecord.query().delete()
    await YieldAllocation.query().delete()
    await YieldReward.query().delete()
  })

  test('fails when the key lacks Earn Funds and passes with healthy responses', async ({ assert }) => {
    await markTickHeartbeat()
    const denied = {
      ...fakeEarn().earn,
      getStrategies: async () => {
        throw new KrakenEarnError('permission', 'EGeneral:Permission denied')
      },
    }

    const failed = await runPreflight(preflightOptions(denied))
    assert.isFalse(failed.passed)
    assert.include(failed.failed, 'key-permission')

    const healthy = await runPreflight(preflightOptions(fakeEarn().earn))
    assert.isTrue(healthy.passed, JSON.stringify(healthy.failed))
  })

  test('fails on orphan intents, stale operations, APY, host, and file mode', async ({ assert }) => {
    const { earn } = fakeEarn()
    await markTickHeartbeat()

    await OperationIntent.create({
      strategyId: 'GHOST',
      asset: 'ETH',
      type: 'allocate',
      status: 'pending',
      amountNative: 1,
      amountUsd: 100,
      priceUsd: 100,
      refid: null,
      error: null,
      createdAt: BASE_NOW - 1000,
      submittedAt: null,
      terminalAt: null,
    })
    const orphan = await runPreflight(preflightOptions(earn))
    assert.isFalse(orphan.passed)
    assert.include(orphan.failed, 'no-orphan-intents')

    await OperationIntent.query().delete()
    await OperationIntent.create({
      strategyId: 'ES-ETH-1',
      asset: 'ETH',
      type: 'allocate',
      status: 'submitted',
      amountNative: 1,
      amountUsd: 100,
      priceUsd: 100,
      refid: 'REF-1',
      error: null,
      createdAt: BASE_NOW - 2 * 3600_000,
      submittedAt: BASE_NOW - 2 * 3600_000,
      terminalAt: null,
    })
    const stale = await runPreflight(preflightOptions(earn))
    assert.include(stale.failed, 'no-stale-operations')

    await OperationIntent.query().delete()
    const lowApy = fakeEarn({ strategies: [strategy({ apyLow: 0.001 })], allocations: [] })
    await YieldAllocation.create({ ...allocation(), canAllocate: true } as any)
    const apy = await runPreflight(preflightOptions(lowApy.earn))
    assert.include(apy.failed, 'apy-in-band')

    const host = await runPreflight(preflightOptions(earn, { host: '0.0.0.0' }))
    assert.include(host.failed, 'loopback-bind')

    const envFile = path.join(os.tmpdir(), `syphon-env-${process.pid}`)
    fs.writeFileSync(envFile, 'KRAKEN_EARN_KEY=x\n', { mode: 0o644 })
    try {
      const mode = await runPreflight(preflightOptions(earn, { envFilePath: envFile }))
      assert.include(mode.failed, 'secret-file-permissions')
    } finally {
      fs.rmSync(envFile, { force: true })
    }
  })

  test('a failed preflight makes no mutating call and a live tick without a pass is refused', async ({ assert }) => {
    const { earn, state } = fakeEarn()
    await markTickHeartbeat()

    const failed = await runPreflight(preflightOptions(earn, { host: '10.0.0.5' }))
    assert.isFalse(failed.passed)
    assert.lengthOf(state.allocateCalls, 0)

    await recordPreflightPass(failed, BASE_NOW)
    const service = new KrakenYieldService({
      earn,
      config: () => BASE_CFG,
      now: () => BASE_NOW,
      live: () => true,
      sleep: async () => {},
      pollTimeoutMs: 0,
      price: async () => 100,
    })

    const refusedForFailure = await service.tick()
    assert.equal(refusedForFailure.status, 'refused')
    assert.equal(refusedForFailure.reason, 'preflight-required')

    // The refusal alerted; the operator acknowledges before retrying.
    await OperationAlert.acknowledge({}, BASE_NOW)
    const passed = await runPreflight(preflightOptions(earn))
    assert.isTrue(passed.passed, JSON.stringify(passed.failed))
    await recordPreflightPass(passed, BASE_NOW)

    const tick = await service.tick()
    assert.equal(tick.status, 'ok')
    assert.lengthOf(state.allocateCalls, 1)
  })

  test('status marks a stale heartbeat and lists unacknowledged alerts', async ({ assert }) => {
    await markTickHeartbeat(BASE_NOW - 3 * 3600_000)
    await OperationAlert.raise({ source: 'yield', severity: 'warning', code: 'reconcile-mismatch', message: 'mismatch', now: BASE_NOW - 1000 })
    await OperationAlert.raise({ source: 'trend', severity: 'info', code: 'note', message: 'ok', now: BASE_NOW - 500 })

    const status = await buildYieldStatus(BASE_NOW)
    assert.isTrue(status.lastTick.stale)
    assert.isFalse(status.preflight.fresh)
    assert.isAtLeast(status.recentAlerts.length, 2)
    assert.isTrue(status.recentAlerts.some((alert) => alert.acknowledgedAt === null))
  })

  test('acknowledging the last alert lets the preflight alert check pass', async ({ assert }) => {
    const { earn } = fakeEarn()
    await markTickHeartbeat()
    const alert = await OperationAlert.raise({ source: 'yield', severity: 'warning', code: 'x', message: 'y', now: BASE_NOW })

    const before = await runPreflight(preflightOptions(earn))
    assert.include(before.failed, 'no-unacknowledged-alerts')

    const acknowledged = await OperationAlert.acknowledge({ id: alert.id }, BASE_NOW)
    assert.equal(acknowledged, 1)

    const after = await runPreflight(preflightOptions(earn))
    assert.notInclude(after.failed, 'no-unacknowledged-alerts')
  })

  test('the reward export has one row per reward and no secret material', async ({ assert }) => {
    await YieldReward.createMany([
      {
        refid: 'R1',
        time: BASE_NOW - 1000,
        ledgerType: 'reward',
        subtype: null,
        asset: 'ETH',
        amount: 0.01,
        balanceAfter: 1,
        strategyId: 'ES-ETH-1',
      },
      {
        refid: 'R2',
        time: BASE_NOW - 2000,
        ledgerType: 'staking',
        subtype: 'bonded',
        asset: 'ETH',
        amount: 0.02,
        balanceAfter: 1.02,
        strategyId: 'ES-ETH-1',
      },
    ])

    const rows = await YieldReward.query().orderBy('time', 'asc')
    const csv = buildYieldReportCsv(rows)
    const lines = csv.trim().split('\n')

    assert.include(lines[0], 'native units only')
    assert.include(lines[1], 'EUR fair-value valuation and tax treatment are NOT applied')
    assert.lengthOf(lines, 5)
    assert.include(lines[2], 'refid')
    assert.isTrue(lines.some((line) => line.includes('R1')))
    assert.isTrue(lines.some((line) => line.includes('R2')))
    assert.notMatch(csv, /KRAKEN_(EARN_)?(KEY|SECRET)/)
  })

  test('preflight fails on trigger multiplicity, an active signer, a leaking log, and venue failures', async ({ assert }) => {
    await markTickHeartbeat()
    const { earn } = fakeEarn()

    const twoTriggers = await runPreflight(
      preflightOptions(earn, { crontabText: '0 * * * * bun ace.js yield:tick\n30 * * * * bun ace.js yield:tick' })
    )
    assert.include(twoTriggers.failed, 'single-yield-trigger')

    const signer = await runPreflight(preflightOptions(earn, { fastAlgoSessionActive: true }))
    assert.include(signer.failed, 'single-signer')

    const logFile = path.join(os.tmpdir(), `syphon-leak-${process.pid}.log`)
    fs.writeFileSync(logFile, 'API-Sign abcdef\n')
    try {
      const leaked = await runPreflight(preflightOptions(earn, { logFile }))
      assert.include(leaked.failed, 'no-key-material-in-logs')
    } finally {
      fs.rmSync(logFile, { force: true })
    }

    const denied = {
      ...earn,
      getAllocations: async () => {
        throw new KrakenEarnError('venue', 'nope')
      },
      getBalance: async () => {
        throw new KrakenEarnError('venue', 'nope')
      },
    }
    const venue = await runPreflight(preflightOptions(denied))
    assert.include(venue.failed, 'allocations-readable')
    assert.include(venue.failed, 'funds-readable')

    const unpriced = await runPreflight(preflightOptions(earn, { price: async () => null }))
    assert.include(unpriced.failed, 'price-source-works')
  })
})
