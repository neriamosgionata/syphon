import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ControlRecord from '../../app/models/ControlRecord.js'
import OperationAlert from '../../app/models/OperationAlert.js'
import AlgoConfig from '../../app/models/AlgoConfig.js'
import AlgoPosition from '../../app/models/AlgoPosition.js'
import Ticker from '../../app/models/Ticker.js'
import Trade from '../../app/models/Trade.js'
import { FastAlgoService } from '../../app/services/FastAlgoService.js'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import { FastStrategy } from '../../app/services/FastStrategy.js'
import KrakenService from '../../app/services/KrakenService.js'
import MeilisearchService from '../../app/services/MeilisearchService.js'
import NotificationService from '../../app/services/NotificationService.js'
import db from '@adonisjs/lucid/services/db'
import JevRollout from '../../app/services/JevRollout.js'
import { runJevPreflight, recordJevPreflightPass, isJevPreflightFresh, JEV_PREFLIGHT_CONTROL_NAME } from '../../app/services/JevPreflight.js'
import { isPreflightFresh } from '../../app/services/YieldPreflight.js'
import { assertIncomeBindSafe } from '../../app/services/income_bind_guard.js'

// U6 staged rollout: shadow → veto-only → live with a latching tripwire,
// preflight-gated live enablement, and loopback boot refusal. Control rows
// and alerts live in the throwaway unit DB; the scorer is always a fake.

async function clearRolloutState() {
  await db.from('control').where('name', 'like', 'jev:%').del()
  await db.from('operation_alerts').where('source', 'jev').del()
}

function fakeScorer(ok: boolean, model = 'jev-1.13.0') {
  return {
    async preflight() {
      return ok
        ? { ok: true, model, failure: null, at: Date.now() }
        : { ok: false, model: null, failure: { class: 'unkeyed', message: 'unset', at: Date.now() }, at: Date.now() }
    },
  }
}

test.group('Jev rollout stage machine', (group) => {
  group.each.setup(async () => {
    await clearRolloutState()
  })

  test('starts in shadow with nothing latched', async ({ assert }) => {
    assert.equal(await JevRollout.getStage(), 'shadow')
    assert.isFalse(await JevRollout.isLatched())
    assert.isFalse(await JevRollout.isEnforcing())
  })

  test('promotes shadow to veto-only to live in order', async ({ assert }) => {
    assert.isTrue((await JevRollout.setStage('veto_only', 'paper gate passed')).ok)
    assert.equal(await JevRollout.getStage(), 'veto_only')
    assert.isTrue(await JevRollout.isEnforcing())
    await recordJevPreflightPass({ passed: true, checks: [], failed: [] })
    assert.isTrue((await JevRollout.setStage('live', 'all gates passed')).ok)
    assert.equal(await JevRollout.getStage(), 'live')
  })

  test('live promotion needs a fresh preflight pass', async ({ assert }) => {
    assert.isTrue((await JevRollout.setStage('veto_only', 'paper gate passed')).ok)
    const refused = await JevRollout.setStage('live', 'no preflight yet')
    assert.isFalse(refused.ok)
    assert.match(refused.error ?? '', /preflight/i)
    assert.equal(await JevRollout.getStage(), 'veto_only')
    await recordJevPreflightPass({ passed: true, checks: [], failed: [] })
    assert.isTrue((await isJevPreflightFresh(Date.now())))
    assert.isTrue((await JevRollout.setStage('live', 'preflight fresh')).ok)
    assert.equal(await JevRollout.getStage(), 'live')
  })

  test('refuses to jump shadow straight to live', async ({ assert }) => {
    const result = await JevRollout.setStage('live', 'impatient')
    assert.isFalse(result.ok)
    assert.match(result.error ?? '', /veto_only/i)
    assert.equal(await JevRollout.getStage(), 'shadow')
  })

  test('standing down to shadow is always allowed', async ({ assert }) => {
    await JevRollout.setStage('veto_only', 'up')
    assert.isTrue((await JevRollout.setStage('shadow', 'stand down')).ok)
    assert.equal(await JevRollout.getStage(), 'shadow')
    assert.isFalse(await JevRollout.isEnforcing())
  })

  test('promotion is blocked by unacknowledged jev alerts', async ({ assert }) => {
    await OperationAlert.raise({ source: 'jev', severity: 'warning', code: 'test', message: 'unacked' })
    const result = await JevRollout.setStage('veto_only', 'up despite alert')
    assert.isFalse(result.ok)
    assert.match(result.error ?? '', /acknowledged/i)
    await OperationAlert.acknowledge({ source: 'jev' })
    assert.isTrue((await JevRollout.setStage('veto_only', 'alerts clear')).ok)
  })

  test('latch-off stops enforcement, raises an alert, and resume re-enters shadow', async ({ assert }) => {
    await JevRollout.setStage('veto_only', 'up')
    await JevRollout.latchOff('calibration breach in test')
    assert.isTrue(await JevRollout.isLatched())
    assert.isFalse(await JevRollout.isEnforcing())
    const unacked = await OperationAlert.unacknowledged('jev')
    assert.isTrue(unacked.some((a) => a.code === 'jev-latched'))

    await JevRollout.resume('operator reviewed')
    assert.isFalse(await JevRollout.isLatched())
    assert.equal(await JevRollout.getStage(), 'shadow')
    // The alert itself stays for the CLI-only ack path.
    assert.isAbove((await OperationAlert.unacknowledged('jev')).length, 0)
  })

  test('tripwire latches on breach or sustained negatives, not on one bad week', async ({ assert }) => {
    assert.isFalse((await JevRollout.evaluateTripwire({ consecutiveNegativePeriods: 1, calibrationBreach: false })).latched)
    assert.isFalse(await JevRollout.isLatched())
    assert.isTrue((await JevRollout.evaluateTripwire({ consecutiveNegativePeriods: 2, calibrationBreach: false })).latched)
    assert.isTrue(await JevRollout.isLatched())

    await JevRollout.resume('reset')
    assert.isTrue((await JevRollout.evaluateTripwire({ consecutiveNegativePeriods: 0, calibrationBreach: true })).latched)
  })
})

test.group('Jev preflight', (group) => {
  group.each.setup(async () => {
    await clearRolloutState()
  })

  test('unkeyed scorer fails the venue check', async ({ assert }) => {
    const result = await runJevPreflight({ jevService: fakeScorer(false), getApiKey: () => null })
    assert.isFalse(result.passed)
    assert.isTrue(result.checks.some((c) => c.name === 'key-present' && !c.ok))
  })

  test('keyed scorer with pinned model passes and records freshness', async ({ assert }) => {
    const result = await runJevPreflight({ jevService: fakeScorer(true), getApiKey: () => 'sk-test' })
    assert.isTrue(result.passed)
    await recordJevPreflightPass(result)
    const row = await ControlRecord.get(JEV_PREFLIGHT_CONTROL_NAME)
    assert.isTrue(isPreflightFresh(row, Date.now(), 3600_000))
    assert.isFalse(isPreflightFresh(row, Date.now() + 2 * 3600_000, 3600_000))
  })

  test('moved model alias fails the venue check', async ({ assert }) => {
    const result = await runJevPreflight({ jevService: fakeScorer(true, 'jev-latest'), getApiKey: () => 'sk-test' })
    assert.isFalse(result.passed)
    assert.isTrue(result.checks.some((c) => c.name === 'model-pinned' && !c.ok))
  })

  test('unacknowledged jev alerts fail preflight', async ({ assert }) => {
    await OperationAlert.raise({ source: 'jev', severity: 'warning', code: 'test', message: 'unacked' })
    const result = await runJevPreflight({ jevService: fakeScorer(true), getApiKey: () => 'sk-test' })
    assert.isFalse(result.passed)
    assert.isTrue(result.checks.some((c) => c.name === 'no-unacknowledged-alerts' && !c.ok))
  })

  test('a failed preflight records failed and is never fresh', async ({ assert }) => {
    const result = await runJevPreflight({ jevService: fakeScorer(false), getApiKey: () => 'sk-test' })
    assert.isFalse(result.passed)
    await recordJevPreflightPass(result)
    const row = await ControlRecord.get(JEV_PREFLIGHT_CONTROL_NAME)
    assert.equal(row?.state, 'failed')
    assert.isFalse(await isJevPreflightFresh(Date.now()))
  })
})

test.group('Jev loopback boot guard', () => {
  test('non-loopback bind with the overlay live refuses to start', ({ assert }) => {
    assert.throws(() => assertIncomeBindSafe('0.0.0.0', { yieldLive: false, trendLive: false, jevLive: true }), /loopback/i)
  })

  test('loopback bind with the overlay live starts fine', ({ assert }) => {
    assert.doesNotThrow(() => assertIncomeBindSafe('127.0.0.1', { yieldLive: false, trendLive: false, jevLive: true }))
  })
})

test.group('Jev enforcement in the live loop', (group) => {
  const origGetTradeBalance = (KrakenService as any).getTradeBalance
  const origSaveDecision = (MeilisearchService as any).saveDecision
  const origEmit = (NotificationService as any).emit

  group.setup(async () => {
    ;(KrakenService as any).getTradeBalance = async () => ({ eb: '10000' })
    ;(MeilisearchService as any).saveDecision = async () => {}
    ;(NotificationService as any).emit = async () => {}
  })

  group.teardown(async () => {
    ;(KrakenService as any).getTradeBalance = origGetTradeBalance
    ;(MeilisearchService as any).saveDecision = origSaveDecision
    ;(NotificationService as any).emit = origEmit
  })

  group.each.setup(async () => {
    await AlgoPosition.query().delete()
    await Trade.query().delete()
    await Ticker.query().delete()
    btcTickerId = (await Ticker.create({ symbol: 'BTC', name: 'Bitcoin', isActive: true })).id
    await clearRolloutState()
  })

  let tradeSeq = 5000
  let btcTickerId = 1

  function makeWs() {
    const prices = new Map<string, number>([['BTC', 100]])
    return {
      getConnectedSymbols: () => [...prices.keys()],
      getPrice: (s: string) => prices.get(s) ?? null,
      addSymbol: (s: string, p: number | null = null) => {
        if (!prices.has(s)) prices.set(s, p as number)
      },
      setPrice: (s: string, p: number) => prices.set(s, p),
    }
  }

  function makeEngine() {
    const engine: any = {
      running: true,
      orders: [] as any[],
      start: async () => {
        engine.running = true
      },
      stop: async () => {
        engine.running = false
      },
      cancelOrder: async () => {},
      pruneCompletedOrders: () => {},
      placeOrder: async (order: any) => {
        engine.orders.push(order)
        const ticker = await Ticker.findBy('symbol', order.symbol)
        const trade = await Trade.create({
          tickerId: ticker!.id,
          symbol: order.symbol,
          side: order.side,
          orderType: 'MKT',
          quantity: order.quantity,
          status: 'filled',
          fillPrice: order.price ?? 100,
          exchange: 'SMART',
        })
        const state = { ...order, clientOrderId: `jr-${++tradeSeq}`, status: 'filled', fillPrice: order.price ?? 100, tradeId: trade.id, tickerId: btcTickerId }
        return state
      },
    }
    return engine
  }

  function bearishJev() {
    const calls: any[] = []
    return {
      calls,
      async getDecision(state: any) {
        calls.push(state)
        return {
          symbol: state.symbol,
          pUp: 0.2,
          pDown: 0.72,
          confidence: 0.8,
          model: 'jev-1.13.0',
          usage: { inputTokens: 10, outputTokens: 0 },
          asOf: Date.now(),
          stale: false,
        }
      },
      isLiveReady: () => false,
      getBudgetState: () => ({ day: 'd', calls: calls.length, spendUsd: 0, maxCallsPerDay: 10000, maxSpendUsdPerDay: 50, deterministicOnly: false }),
      getLastFailure: () => null,
      getProvenance: () => ({ model: 'jev-1.13.0', usage: { inputTokens: 10, outputTokens: 0 }, at: Date.now(), symbol: 'BTC' }),
      isDeterministicOnly: () => false,
    }
  }

  async function seedLiveConfig(overrides: Record<string, any> = {}) {
    const base: Record<string, any> = {
      enabled: true,
      dryRun: false,
      broker: 'kraken',
      fastEnabled: true,
      fastIntervalSeconds: 10,
      fastWatchlist: ['BTC'],
      fastMomentumSeconds: 30,
      fastMomentumThresholdPct: 0.1,
      fastRsiLow: 0,
      fastRsiHigh: 1000,
      fastStopLossPct: 0.5,
      fastTakeProfitPct: 1.5,
      fastExitReversalPct: -0.3,
      fastCooldownSeconds: 30,
      fastJevGateEnabled: true,
      fastJevMinConfidence: 0.5,
      fastJevMinEdgePct: 0.15,
      fastJevTimeoutMs: 500,
      fastJevShadowOnly: false,
      maxPositions: 5,
      maxExposurePct: 0.8,
      maxSinglePositionPct: 0.15,
      dailyLossLimitPct: 0.05,
      ...overrides,
    }
    const existing = await AlgoConfig.find(1)
    if (existing) {
      await existing.merge(base).save()
      return (await AlgoConfig.find(1))!
    }
    return AlgoConfig.create(base)
  }

  function pumpRising(service: any) {
    const now = Date.now()
    let price = 100
    for (let i = 0; i < 60; i++) {
      price = price * 1.0002
      service.ws.setPrice('BTC', price)
      service.feed.push('BTC', price, now - (59 - i) * 1000)
    }
  }

  function liveService(jevService: any, rollout: any) {
    return new FastAlgoService({
      engine: makeEngine(),
      ws: makeWs(),
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService,
      jevRollout: rollout,
      meili: { getAnalysesForTicker: async () => [] },
    })
  }

  test('latched overlay fetches nothing and trades deterministically', async ({ assert }) => {
    const jev = bearishJev()
    const service = liveService(jev, { getStage: async () => 'veto_only', isLatched: async () => true })
    pumpRising(service)
    const cfg = await seedLiveConfig()
    await (service as any).checkEntries(cfg, new Set())
    assert.equal(jev.calls.length, 0)
    assert.equal((service as any).engine.orders.length, 1)
  })

  test('live stage without fresh preflight degrades to shadow', async ({ assert }) => {
    const jev = bearishJev()
    const service = liveService(jev, { getStage: async () => 'live', isLatched: async () => false })
    pumpRising(service)
    const cfg = await seedLiveConfig()
    await (service as any).checkEntries(cfg, new Set())
    // Bearish read fetched but not enforced — the warm entry still places.
    assert.equal(jev.calls.length, 1)
    assert.equal((service as any).engine.orders.length, 1)
  })

  test('live stage with fresh preflight enforces the veto', async ({ assert }) => {
    const jev = bearishJev()
    ;(jev as any).isLiveReady = () => true
    const service = liveService(jev, { getStage: async () => 'live', isLatched: async () => false })
    pumpRising(service)
    const cfg = await seedLiveConfig()
    await (service as any).checkEntries(cfg, new Set())
    assert.equal((service as any).engine.orders.length, 0)
  })

  test('veto-only stage enforces without preflight', async ({ assert }) => {
    const jev = bearishJev()
    const service = liveService(jev, { getStage: async () => 'veto_only', isLatched: async () => false })
    pumpRising(service)
    const cfg = await seedLiveConfig()
    await (service as any).checkEntries(cfg, new Set())
    assert.equal((service as any).engine.orders.length, 0)
  })
})
