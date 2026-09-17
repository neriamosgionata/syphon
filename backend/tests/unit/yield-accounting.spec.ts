import { test } from '@japa/runner'
import { YieldAccounting, isRewardLedgerType } from '../../app/services/YieldAccounting.js'
import YieldAllocation from '../../app/models/YieldAllocation.js'
import YieldReward from '../../app/models/YieldReward.js'

// Yield accounting: insert-only ledger projection + post-baseline reconciliation.
// Rows live in the throwaway unit DB; no venue calls.

const accounting = new YieldAccounting()

async function allocation(overrides: Record<string, any> = {}) {
  return accounting.upsertAllocation(
    {
      strategyId: 's1',
      asset: 'ETH',
      lockType: 'bonded',
      canAllocate: true,
      totalRewardedNative: 0.5,
      ...overrides,
    },
    1000
  )
}

test.group('YieldAccounting', (group) => {
  group.each.setup(async () => {
    await YieldReward.query().delete()
    await YieldAllocation.query().delete()
  })

  test('upsert refreshes one strategy row and freezes the baseline once', async ({ assert }) => {
    const first = await allocation()
    assert.equal(first.baselineRewardedNative, 0.5)

    const again = await accounting.upsertAllocation(
      {
        strategyId: 's1',
        asset: 'ETH',
        lockType: 'bonded',
        canAllocate: true,
        allocatedNative: 2,
        totalRewardedNative: 0.9,
      },
      2000
    )

    assert.lengthOf(await YieldAllocation.all(), 1)
    assert.equal(again.allocatedNative, 2)
    assert.equal(again.baselineRewardedNative, 0.5)
  })

  test('re-ingesting the same ledger window inserts no duplicate rewards', async ({ assert }) => {
    const entries = [
      { refid: 'r1', time: 2000, ledgerType: 'reward', asset: 'ETH', amount: 0.01 },
      { refid: 'r2', time: 3000, ledgerType: 'staking', asset: 'ETH', amount: 0.02 },
    ]
    assert.equal(await accounting.ingestRewards(entries), 2)
    assert.equal(await accounting.ingestRewards(entries), 0)
    assert.lengthOf(await YieldReward.all(), 2)
  })

  test('known and unknown ledger types are stored; only reward types count', async ({ assert }) => {
    assert.isTrue(isRewardLedgerType('staking'))
    assert.isTrue(isRewardLedgerType('reward'))
    assert.isTrue(isRewardLedgerType('earn'))
    assert.isFalse(isRewardLedgerType('trade'))

    const inserted = await accounting.ingestRewards([
      { refid: 'a', time: 2000, ledgerType: 'staking', asset: 'ETH', amount: 0.01 },
      { refid: 'b', time: 2000, ledgerType: 'reward', asset: 'ETH', amount: 0.02 },
      { refid: 'c', time: 2000, ledgerType: 'earn', asset: 'ETH', amount: 0.03 },
      { refid: 'd', time: 2000, ledgerType: 'someFutureType', asset: 'ETH', amount: 9 },
    ])
    assert.equal(inserted, 4)

    const realized = await accounting.realizedByAsset(0, 10_000)
    assert.lengthOf(realized, 1)
    assert.closeTo(realized[0].amount, 0.06, 1e-12)
  })

  test('reconciliation compares post-baseline deltas, not lifetime totals', async ({ assert }) => {
    await allocation()

    const firstRun = await accounting.reconcileVenue('s1', 0.5)
    assert.isTrue(firstRun.ok)
    assert.equal(firstRun.venueDelta, 0)

    await accounting.ingestRewards(
      [{ refid: 'r1', time: 2000, ledgerType: 'reward', asset: 'ETH', amount: 0.05 }],
      's1'
    )

    const matched = await accounting.reconcileVenue('s1', 0.55)
    assert.isTrue(matched.ok)

    const mismatched = await accounting.reconcileVenue('s1', 0.8)
    assert.isFalse(mismatched.ok)
    assert.isAbove(Math.abs(mismatched.delta), mismatched.tolerance)
  })

  test('dust below the asset precision is recorded but never a re-allocation candidate', async ({ assert }) => {
    await accounting.ingestRewards([
      { refid: 'dust', time: 2000, ledgerType: 'reward', asset: 'ETH', amount: 1e-9 },
    ])
    assert.lengthOf(await YieldReward.all(), 1)
    assert.lengthOf(await accounting.reallocationCandidates(0, { ETH: 8 }), 0)

    await accounting.ingestRewards([
      { refid: 'real', time: 3000, ledgerType: 'reward', asset: 'ETH', amount: 0.01 },
    ])
    const candidates = await accounting.reallocationCandidates(0, { ETH: 8 })
    assert.lengthOf(candidates, 1)
    assert.closeTo(candidates[0].amount, 0.01, 1e-12)
    assert.equal(candidates[0].rewards, 1)
  })
})
