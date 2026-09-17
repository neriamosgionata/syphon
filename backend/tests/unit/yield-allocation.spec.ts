import { test } from '@japa/runner'
import { KrakenYieldService } from '../../app/services/KrakenYieldService.js'
import { YieldAccounting } from '../../app/services/YieldAccounting.js'
import { KrakenEarnError } from '../../app/services/KrakenEarnClient.js'
import { planYieldAction } from '../../app/services/YieldPolicy.js'
import { applyCaps, validateYieldConfig } from '../../app/services/YieldGuard.js'
import OperationIntent from '../../app/models/OperationIntent.js'
import OperationAlert from '../../app/models/OperationAlert.js'
import ControlRecord from '../../app/models/ControlRecord.js'
import YieldAllocation from '../../app/models/YieldAllocation.js'
import YieldReward from '../../app/models/YieldReward.js'
import { recordPreflightPass } from '../../app/services/YieldPreflight.js'

// Yield tick: observe-first, intent-first, one-in-flight-per-strategy,
// fail-closed ceilings, durable lock, persisted skip reasons, and adoption
// of non-terminal intents after a crash. No network: the Earn surface is a
// stub and prices are injected.

const BASE_NOW = Date.now()

const BASE_CFG = {
  allowlist: ['ETH', 'SOL'],
  bufferPct: 25,
  minAllocationUsd: 10,
  apyFloorPct: 0.5,
  apyCeilingPct: 5,
  maxPerAssetUsd: 10_000,
  maxTotalUsd: 20_000,
}

/** Live ticks are refused without a fresh recorded preflight pass. */
async function passPreflight() {
  await recordPreflightPass({ passed: true, checks: [], failed: [] }, BASE_NOW)
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
    deallocateCalls: [],
    getStrategiesCalls: 0,
    refid: 0,
    allocateError: null,
    ledgerError: null,
    statuses: [],
    ledgerEntries: [],
    ...overrides,
  }

  const earn = {
    getStrategies: async () => {
      state.getStrategiesCalls++
      return state.strategies
    },
    getAllocations: async () => state.allocations,
    getBalance: async () => state.balances,
    getLedgers: async () => {
      if (state.ledgerError) throw state.ledgerError
      return { entries: state.ledgerEntries, count: state.ledgerEntries.length }
    },
    allocate: async (strategyId: string, amount: number) => {
      state.allocateCalls.push({ strategyId, amount })
      if (state.allocateError) throw state.allocateError
      state.refid++
      return { refid: `REF-${state.refid}` }
    },
    deallocate: async (strategyId: string, amount: number) => {
      state.deallocateCalls.push({ strategyId, amount })
      return { refid: `DREF-${state.refid}` }
    },
    getAllocateStatus: async (refid: string) => ({
      refid,
      status: state.statuses.length > 0 ? state.statuses.shift() : 'success',
      strategyId: null,
      amount: null,
      error: null,
    }),
    getDeallocateStatus: async (refid: string) => ({
      refid,
      status: 'success',
      strategyId: null,
      amount: null,
      error: null,
    }),
  }

  return { earn, state }
}

function makeService(earn: any, opts: Record<string, any> = {}) {
  return new KrakenYieldService({
    earn,
    accounting: new YieldAccounting(),
    price: async () => 100,
    now: () => opts.now ?? BASE_NOW,
    live: () => opts.live === true,
    sleep: async () => {},
    pollIntervalMs: 1000,
    pollTimeoutMs: opts.pollTimeoutMs ?? 0,
    staleIntentMs: opts.staleIntentMs ?? 2 * 3600_000,
    config: () => ({ ...BASE_CFG, ...(opts.cfg ?? {}) }),
  })
}

async function alertsByCode() {
  const rows = await OperationAlert.all()
  return rows.map((row) => row.code)
}

test.group('KrakenYieldService', (group) => {
  group.each.setup(async () => {
    await OperationAlert.query().delete()
    await OperationIntent.query().delete()
    await ControlRecord.query().delete()
    await YieldReward.query().delete()
    await YieldAllocation.query().delete()
  })

  test('observe mode performs every step except the mutating call', async ({ assert }) => {
    const { earn, state } = fakeEarn()
    const service = makeService(earn, { live: false })

    const result = await service.tick()

    assert.equal(result.status, 'ok')
    assert.isFalse(result.live)
    assert.lengthOf(state.allocateCalls, 0)
    assert.lengthOf(state.deallocateCalls, 0)
    assert.equal(state.getStrategiesCalls, 1)
    assert.lengthOf(result.actions ?? [], 1)
    assert.lengthOf(result.executed ?? [], 0)
    assert.lengthOf(await YieldAllocation.all(), 1)
  })

  test('ineligible assets are skipped with the reason persisted', async ({ assert }) => {
    const { earn } = fakeEarn({
      strategies: [strategy(), strategy({ strategyId: 'ES-SOL-1', asset: 'SOL' })],
      allocations: [allocation(), allocation({ strategyId: 'ES-SOL-1', asset: 'SOL' })],
      balances: { XETH: '0.1', SOL: '0' },
    })
    const service = makeService(earn, { live: false })

    const result = await service.tick()
    const reasons = (result.skips ?? []).map((skip) => skip.reason)
    assert.include(reasons, 'below-minimum')
    assert.include(reasons, 'below-buffer')

    const control = await ControlRecord.get('yield:tick')
    const persisted = (control?.detail?.skips ?? []).map((skip: any) => skip.reason)
    assert.include(persisted, 'below-minimum')
    assert.include(persisted, 'below-buffer')
  })

  test('a pending operation blocks a second allocation and is never resubmitted', async ({ assert }) => {
    const { earn, state } = fakeEarn({ statuses: ['pending', 'pending'] })
    const service = makeService(earn, { live: true })
    await passPreflight()

    const first = await service.tick()
    assert.equal(state.allocateCalls.length, 1)
    assert.equal((first.executed ?? [])[0].status, 'submitted')
    assert.include(await alertsByCode(), 'allocation-unknown')

    const second = await service.tick()
    assert.equal(state.allocateCalls.length, 1, 'no second mutating call while pending')
    assert.include((second.skips ?? []).map((skip) => skip.reason), 'pending-operation')

    const intent = await OperationIntent.firstOrFail()
    assert.equal(intent.status, 'submitted')
    assert.isUndefined(intent.terminalAt ?? undefined)
  })

  test('a venue failure alerts and is not retried within the tick', async ({ assert }) => {
    const { earn, state } = fakeEarn({ statuses: ['error'] })
    const service = makeService(earn, { live: true })
    await passPreflight()

    const result = await service.tick()
    assert.equal(state.allocateCalls.length, 1)
    assert.equal((result.executed ?? [])[0].status, 'failed')
    assert.include(await alertsByCode(), 'allocation-failed')

    const intent = await OperationIntent.firstOrFail()
    assert.equal(intent.status, 'failed')
    assert.isNotNull(intent.terminalAt)
  })

  test('an ambiguous transport failure leaves the intent non-terminal with no second request', async ({ assert }) => {
    const { earn, state } = fakeEarn({
      allocateError: new KrakenEarnError('transport', 'fetch failed'),
    })
    const service = makeService(earn, { live: true })
    await passPreflight()

    await service.tick()
    assert.equal(state.allocateCalls.length, 1)
    assert.include(await alertsByCode(), 'ambiguous-allocation')

    const intent = await OperationIntent.firstOrFail()
    assert.equal(intent.status, 'pending')
    assert.isNull(intent.terminalAt)
  })

  test('a crashed mid-operation intent is adopted or escalated, never double-submitted', async ({ assert }) => {
    const { earn, state } = fakeEarn()
    await OperationIntent.create({
      strategyId: 'ES-ETH-1',
      asset: 'ETH',
      type: 'allocate',
      status: 'submitted',
      amountNative: 1,
      amountUsd: 100,
      priceUsd: 100,
      refid: null,
      error: null,
      createdAt: BASE_NOW - 3 * 3600_000,
      submittedAt: null,
      terminalAt: null,
    })

    const service = makeService(earn, { live: true })
    await passPreflight()
    const result = await service.tick()

    assert.lengthOf(state.allocateCalls, 0, 'crash residue must not be resubmitted')
    assert.include(await alertsByCode(), 'ambiguous-intent')
    assert.include((result.skips ?? []).map((skip) => skip.reason), 'pending-operation')

    const intent = await OperationIntent.firstOrFail()
    assert.equal(intent.status, 'submitted')
  })

  test('an excessive configuration refuses the tick before any venue call', async ({ assert }) => {
    const { earn, state } = fakeEarn()
    const service = makeService(earn, { live: true, cfg: { maxTotalUsd: 999_999 } })

    const result = await service.tick()

    assert.equal(result.status, 'refused')
    assert.equal(state.getStrategiesCalls, 0)
    assert.lengthOf(state.allocateCalls, 0)
    assert.include(await alertsByCode(), 'invalid-config')
  })

  test('per-asset and total caps drop planned allocations', async ({ assert }) => {
    const { earn, state } = fakeEarn()
    const service = makeService(earn, { live: true, cfg: { maxPerAssetUsd: 50 } })
    await passPreflight()

    const result = await service.tick()

    assert.lengthOf(state.allocateCalls, 0)
    assert.include((result.skips ?? []).map((skip) => skip.reason), 'cap-reached')
  })

  test('a concurrent tick is denied by the lock and a missed heartbeat is detectable', async ({ assert }) => {
    const { earn, state } = fakeEarn()
    await ControlRecord.tryAcquire('yield:tick', 'other-owner', 60_000, Date.now())

    const blocked = await makeService(earn, { live: true }).tick()
    assert.equal(blocked.status, 'skipped')
    assert.equal(blocked.reason, 'lock-held')
    assert.equal(state.getStrategiesCalls, 0)

    await ControlRecord.release('yield:tick', 'other-owner')
    await passPreflight()
    await makeService(earn, { live: true }).tick()

    assert.isFalse(await ControlRecord.isStale('yield:tick', BASE_NOW + 1000, 3600_000))
    assert.isTrue(await ControlRecord.isStale('yield:tick', BASE_NOW + 5 * 3600_000, 3600_000))
  })

  test('intents are append-only and every venue mutation has one', async ({ assert }) => {
    const { earn, state } = fakeEarn({ statuses: ['success'] })
    const service = makeService(earn, { live: true })
    await passPreflight()

    await service.tick()

    assert.equal(state.allocateCalls.length, 1)
    assert.lengthOf(await OperationIntent.all(), 1)

    const intent = await OperationIntent.firstOrFail()
    assert.equal(intent.strategyId, 'ES-ETH-1')
    assert.equal(intent.type, 'allocate')
    assert.equal(intent.status, 'success')
    assert.equal(intent.createdAt, BASE_NOW)
    assert.closeTo(intent.amountNative!, state.allocateCalls[0].amount, 1e-12)
    assert.equal(intent.amountNative, 1.5)
    assert.isNotNull(intent.terminalAt)
  })

  test('the USD minimum decides, sized in native units; flex is report-only', async ({ assert }) => {
    const { earn, state } = fakeEarn({
      strategies: [
        strategy({ minAllocationUsd: 50 }),
        strategy({ strategyId: 'ES-SOL-FLEX', asset: 'SOL', lockType: 'flex' }),
      ],
      allocations: [
        allocation({ minAllocationUsd: 50 }),
        allocation({ strategyId: 'ES-SOL-FLEX', asset: 'SOL', lockType: 'flex' }),
      ],
      balances: { XETH: '1', SOL: '5' },
    })
    const service = makeService(earn, { live: true })
    await passPreflight()

    const result = await service.tick()

    assert.lengthOf(state.allocateCalls, 1)
    assert.closeTo(state.allocateCalls[0].amount, 0.75, 1e-12)
    assert.include((result.skips ?? []).map((skip) => skip.reason), 'report-only')

    const intent = await OperationIntent.firstOrFail()
    assert.closeTo(intent.amountNative!, 0.75, 1e-12)
    assert.closeTo(intent.amountUsd!, 75, 1e-9)
  })

  test('policy skip branches and cap arithmetic are exhaustive', ({ assert }) => {
    const cfg = { ...BASE_CFG }
    const base = {
      strategy: {
        strategyId: 's1',
        asset: 'ETH',
        lockType: 'instant',
        canAllocate: true,
        allocatedNative: 0,
        minAllocationUsd: 0,
        userCapUsd: 1000,
        apyLow: 0.03,
      },
      freeNative: 1,
      totalNative: 1,
      priceUsd: 100,
      hasPendingIntent: false,
    }

    assert.equal(
      planYieldAction({ ...base, strategy: { ...base.strategy, asset: 'DOGE' } }, cfg).skip?.reason,
      'not-allowlisted'
    )
    assert.equal(
      planYieldAction({ ...base, strategy: { ...base.strategy, canAllocate: false } }, cfg).skip?.reason,
      'not-allocatable'
    )
    assert.equal(
      planYieldAction({ ...base, strategy: { ...base.strategy, apyLow: 0.001 } }, cfg).skip?.reason,
      'apy-below-floor'
    )
    assert.equal(planYieldAction({ ...base, priceUsd: null }, cfg).skip?.reason, 'no-price')
    assert.equal(
      planYieldAction({ ...base, strategy: { ...base.strategy, userCapUsd: 0 } }, cfg).skip?.reason,
      'cap-reached'
    )

    const action = {
      strategyId: 's1',
      asset: 'ETH',
      lockType: 'instant',
      amountNative: 1,
      amountUsd: 100,
      priceUsd: 100,
    }
    const totalCapped = applyCaps([action], { ...cfg, maxTotalUsd: 50 }, {
      totalAllocatedUsd: 0,
      allocatedUsdByAsset: {},
    })
    assert.lengthOf(totalCapped.actions, 0)
    assert.equal(totalCapped.skips[0].detail, 'total cap')

    const assetCapped = applyCaps([action], { ...cfg, maxPerAssetUsd: 50 }, {
      totalAllocatedUsd: 0,
      allocatedUsdByAsset: {},
    })
    assert.equal(assetCapped.skips[0].detail, 'per-asset cap')

    assert.throws(() => validateYieldConfig({ ...cfg, allowlist: [] }))
    assert.throws(() => validateYieldConfig({ ...cfg, bufferPct: 1 }))
    assert.throws(() => validateYieldConfig({ ...cfg, minAllocationUsd: -1 }))
    assert.throws(() => validateYieldConfig({ ...cfg, apyFloorPct: 99 }))
    assert.throws(() => validateYieldConfig({ ...cfg, apyCeilingPct: 0.1 }))
    assert.throws(() => validateYieldConfig({ ...cfg, maxPerAssetUsd: 200_000 }))
    assert.throws(() => validateYieldConfig({ ...cfg, maxTotalUsd: 1 }))
  })

  test('deallocate runs through the intent machinery to a terminal state', async ({ assert }) => {
    const { earn } = fakeEarn()
    await YieldAllocation.create({ ...allocation(), allocatedNative: 2 } as any)
    const service = makeService(earn, { live: false })

    const result = await service.deallocate('ES-ETH-1', 0.5)

    assert.equal(result.status, 'success')
    const intent = await OperationIntent.firstOrFail()
    assert.equal(intent.type, 'deallocate')
    assert.equal(intent.status, 'success')
    assert.isNotNull(intent.terminalAt)
  })

  test('an expired lease is adoptable and a non-owner release is a no-op', async ({ assert }) => {
    await ControlRecord.ensure('yield:test-lease')
    assert.isTrue(await ControlRecord.tryAcquire('yield:test-lease', 'owner-a', 1000, BASE_NOW))
    assert.isFalse(await ControlRecord.tryAcquire('yield:test-lease', 'owner-b', 1000, BASE_NOW + 500))
    assert.isTrue(await ControlRecord.tryAcquire('yield:test-lease', 'owner-b', 1000, BASE_NOW + 2000))

    await ControlRecord.release('yield:test-lease', 'owner-a')
    const row = await ControlRecord.get('yield:test-lease')
    assert.equal(row?.owner, 'owner-b')
  })

  test('a ledger failure is fail-open and a vanished strategy alerts', async ({ assert }) => {
    const { earn } = fakeEarn({ ledgerError: new Error('ledger down') })
    await YieldAllocation.create({ ...allocation(), strategyId: 'GHOST', asset: 'GHOST' } as any)

    const result = await makeService(earn, { live: false }).tick()

    assert.equal(result.status, 'ok')
    assert.equal(result.rewardsIngested, 0)
    const codes = (await OperationAlert.all()).map((alert) => alert.code)
    assert.include(codes, 'ledger-failed')
    assert.include(codes, 'strategy-missing')
  })
})
