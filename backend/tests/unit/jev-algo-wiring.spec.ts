import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { FastAlgoService } from '../../app/services/FastAlgoService.js'
import AlgoConfig from '../../app/models/AlgoConfig.js'
import AlgoPosition from '../../app/models/AlgoPosition.js'
import Ticker from '../../app/models/Ticker.js'
import Trade from '../../app/models/Trade.js'
import AlgoController from '../../app/controllers/AlgoController.js'
import KrakenService from '../../app/services/KrakenService.js'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import { FastStrategy } from '../../app/services/FastStrategy.js'
import MeilisearchService from '../../app/services/MeilisearchService.js'
import NotificationService from '../../app/services/NotificationService.js'

// U3 live-tick wiring: the loop fetches one Jev context per symbol inside a
// deadline, enforces it unless shadow-only, shrinks size through the
// shrink-only map, annotates exits, and reports overlay state. Runs against
// the throwaway unit DB with fake engine/WS/scorer — only the wiring is
// under test.

let tradeSeq = 1000
let btcTickerId = 1

function makeWs(initial: Record<string, number> = {}) {
  const prices = new Map(Object.entries(initial))
  return {
    getConnectedSymbols: () => [...prices.keys()],
    getPrice: (s: string) => prices.get(s) ?? null,
    addSymbol: (s: string, price: number | null = null) => {
      if (!prices.has(s)) prices.set(s, price as number)
    },
    setPrice: (s: string, p: number) => prices.set(s, p),
    symbols: prices,
  }
}

function makeEngine(opts: { tickerId?: number } = {}) {
  const defaultTickerId = () => opts.tickerId ?? btcTickerId
  const engine: any = {
    running: false,
    cancelled: [] as string[],
    orders: [] as any[],
    states: [] as any[],
    start: async () => {
      engine.running = true
    },
    stop: async () => {
      engine.running = false
    },
    cancelOrder: async (clientOrderId: string) => {
      engine.cancelled.push(clientOrderId)
    },
    pruneCompletedOrders: () => {},
    persistTrade: async (state: any, tickerId: number, symbol: string, side: string, orderType: string, quantity: number) => {
      const trade = await Trade.create({
        tickerId,
        symbol,
        side,
        orderType: orderType === 'LIMIT' ? 'LMT' : 'MKT',
        quantity,
        status: 'filled',
        fillPrice: state.fillPrice ?? null,
        exchange: 'SMART',
      })
      state.tradeId = trade.id
      return trade.id
    },
    placeOrder: async (order: any) => {
      engine.orders.push(order)
      const state = {
        ...order,
        clientOrderId: `co-${++tradeSeq}`,
        status: 'filled',
        fillPrice: order.price ?? 100,
        tradeId: null,
        tickerId: defaultTickerId(),
      }
      engine.states.push(state)
      await engine.persistTrade(state, state.tickerId, order.symbol, order.side, order.orderType, order.quantity)
      return state
    },
  }
  return engine
}

function makeJev(impl?: (state: any) => Promise<any>) {
  const calls: any[] = []
  let failure: any = null
  return {
    calls,
    async getDecision(state: any) {
      calls.push(state)
      if (impl) return impl(state)
      return {
        symbol: state.symbol,
        pUp: 0.7,
        pDown: 0.2,
        confidence: 0.8,
        model: 'jev-1.13.0',
        usage: { inputTokens: 10, outputTokens: 0 },
        asOf: Date.now(),
        stale: false,
      }
    },
    getBudgetState: () => ({
      day: 'd',
      calls: calls.length,
      spendUsd: 0,
      maxCallsPerDay: 10000,
      maxSpendUsdPerDay: 50,
      deterministicOnly: false,
    }),
    getLastFailure: () => failure,
    setFailure: (f: any) => {
      failure = f
    },
    getProvenance: () => ({
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 0 },
      at: Date.now(),
      symbol: 'BTC',
    }),
    isDeterministicOnly: () => false,
  }
}

function makeMeili() {
  return { getAnalysesForTicker: async () => [] }
}

function enforcingRollout() {
  return { getStage: async () => 'veto_only', isLatched: async () => false }
}

async function seedConfig(overrides: Record<string, any> = {}): Promise<AlgoConfig> {
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
    fastTrailingStopPct: 0,
    fastTrailingActivatePct: 0,
    fastMaxHoldSeconds: 0,
    fastEmaPeriod: 0,
    fastVolatilityWindowSeconds: 0,
    fastVolatilityMult: 0,
    fastVolatilityFloorPct: 0.05,
    fastVolatilityCeilingPct: 0,
    fastTrendMode: false,
    fastCorrelatedExposurePct: 0.35,
    fastRiskPerTradePct: 0,
    fastMaxLossStreak: 0,
    fastJevGateEnabled: true,
    fastJevMinConfidence: 0.5,
    fastJevMinEdgePct: 0.15,
    fastJevTimeoutMs: 150,
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

async function makeTicker(symbol: string): Promise<Ticker> {
  const existing = await Ticker.findBy('symbol', symbol)
  if (existing) return existing
  return Ticker.create({ symbol, name: symbol, isActive: true })
}

function pumpRising(service: any, symbol: string, steps: number, base: number, stepPct: number) {
  const now = Date.now()
  let price = base
  for (let i = 0; i < steps; i++) {
    price = price * (1 + stepPct / 100)
    service.ws.setPrice(symbol, price)
    service.feed.push(symbol, price, now - (steps - 1 - i) * 1000)
  }
  return price
}

async function makePosition(opts: Record<string, any> = {}): Promise<AlgoPosition> {
  const ticker = await makeTicker(opts.symbol ?? 'BTC')
  const entryTrade = await Trade.create({
    tickerId: ticker.id,
    symbol: opts.symbol ?? 'BTC',
    side: 'BUY',
    orderType: 'MKT',
    quantity: 0.5,
    status: 'filled',
    fillPrice: 100,
    exchange: 'SMART',
  })
  return AlgoPosition.create({
    tickerId: ticker.id,
    symbol: opts.symbol ?? 'BTC',
    side: 'BUY',
    quantity: 0.5,
    entryPrice: 100,
    currentPrice: 100,
    stopLoss: opts.stopLoss ?? 99,
    takeProfit: opts.takeProfit ?? 105,
    entryScore: 1,
    entryConviction: 0.5,
    entryRegime: 'momentum',
    entryReason: 'test',
    entryTradeId: entryTrade.id,
    status: 'open',
    forceClose: false,
    scaledOut: false,
    peakPrice: 100,
    openedAt: DateTime.now(),
  })
}

test.group('Jev live-tick wiring', (group) => {
  const origGetTradeBalance = (KrakenService as any).getTradeBalance
  const origSaveDecision = (MeilisearchService as any).saveDecision
  const origEmit = (NotificationService as any).emit

  group.setup(async () => {
    ;(KrakenService as any).getTradeBalance = async () => ({ eb: '10000' })
    ;(MeilisearchService as any).saveDecision = async () => {}
    ;(NotificationService as any).emit = async () => {}
    await seedConfig({ fastJevGateEnabled: false })
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
    btcTickerId = (await makeTicker('BTC')).id
    await seedConfig()
  })

  group.each.teardown(async () => {
    await AlgoPosition.query().delete()
    await Trade.query().delete()
    await Ticker.query().delete()
  })

  test('slow scorer resolves the tick deterministically without skipping', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const hanging = makeJev(() => new Promise(() => {}) as any)
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: hanging,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastJevTimeoutMs: 150 })
    const started = Date.now()
    await (service as any).checkEntries(cfg, new Set())
    assert.isTrue(Date.now() - started < 3000)
    // Deterministic entry still placed despite the hung scorer.
    assert.equal(engine.orders.length, 1)
    assert.equal(hanging.calls.length, 1)
  })

  test('bearish read vetoes the entry when enforced', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const jev = makeJev(async (state: any) => ({
      symbol: state.symbol,
      pUp: 0.2,
      pDown: 0.72,
      confidence: 0.8,
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 0 },
      asOf: Date.now(),
      stale: false,
    }))
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: jev,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastJevShadowOnly: false })
    await (service as any).checkEntries(cfg, new Set())
    assert.equal(engine.orders.length, 0)
    assert.equal(jev.calls.length, 1)
  })

  test('shadow-only fetches without influencing the decision', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const jev = makeJev(async (state: any) => ({
      symbol: state.symbol,
      pUp: 0.2,
      pDown: 0.72,
      confidence: 0.8,
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 0 },
      asOf: Date.now(),
      stale: false,
    }))
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: jev,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastJevShadowOnly: true })
    await (service as any).checkEntries(cfg, new Set())
    // Same bearish read as the veto test, but the warm entry still places.
    assert.equal(engine.orders.length, 1)
    assert.equal(jev.calls.length, 1)
  })

  test('unkeyed scorer runs the full loop with zero influence', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const jev = makeJev(async () => null)
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: jev,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig()
    await (service as any).checkEntries(cfg, new Set())
    assert.equal(engine.orders.length, 1)
  })

  test('stop-loss exit executes while the scorer is down', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 95 })
    const jev = makeJev(async () => {
      throw new Error('jev down')
    })
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: jev,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    const pos = await makePosition({ status: 'open', stopLoss: 99, takeProfit: 105 })

    const cfg = await seedConfig()
    await (service as any).checkExit(pos, cfg)

    assert.equal(engine.orders.length, 1)
    const reloaded = await AlgoPosition.find(pos.id)
    assert.match(reloaded?.exitReason ?? '', /stop[- ]loss/i)
  })

  test('status reports overlay state', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: makeJev(),
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)
    await seedConfig()
    await (service as any).tick()

    const jev = service.status().jev
    assert.isTrue(jev.enabled)
    assert.equal(jev.model, 'jev-1.13.0')
    assert.isFalse(jev.deterministicOnly)
    assert.exists(jev.strategy)
  })

  test('fresh contexts are reused instead of re-scoring every tick', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const jev = makeJev(async (state: any) => ({
      symbol: state.symbol,
      pUp: 0.2,
      pDown: 0.72,
      confidence: 0.8,
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 0 },
      asOf: Date.now(),
      stale: false,
    }))
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: jev,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastJevShadowOnly: false })
    await (service as any).checkEntries(cfg, new Set())
    assert.equal(jev.calls.length, 1)
    // Second pass re-evaluates the warm symbol but serves the cached read.
    ;(service as any).symbolCooldowns.clear()
    await (service as any).checkEntries(cfg, new Set())
    assert.equal(jev.calls.length, 1)
  })

  test('status reports freshness ages and session veto counts', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const jev = makeJev(async (state: any) => ({
      symbol: state.symbol,
      pUp: 0.2,
      pDown: 0.72,
      confidence: 0.8,
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 0 },
      asOf: Date.now(),
      stale: false,
    }))
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService: jev,
      jevRollout: enforcingRollout(),
      meili: makeMeili(),
    })
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastJevShadowOnly: false })
    await (service as any).checkEntries(cfg, new Set())

    const status = service.status().jev
    assert.equal(status.vetoes, 1)
    assert.isNumber(status.freshness.BTC)
    assert.isAtLeast(status.freshness.BTC, 0)
  })

  test('updateConfig accepts the fastJev fields', async ({ assert }) => {    const controller = new AlgoController()
    const seen: any[] = []
    const ctx: any = {
      request: {
        body: () => ({
          fastJevGateEnabled: true,
          fastJevMinConfidence: 0.7,
          fastJevMinEdgePct: 0.2,
          fastJevTimeoutMs: 1500,
          fastJevShadowOnly: false,
        }),
      },
      response: { ok: (v: any) => {
        seen.push(v)
        return v
      } },
    }
    await controller.updateConfig(ctx)
    const saved = await AlgoConfig.getConfig()
    assert.isTrue(!!saved.fastJevGateEnabled)
    assert.closeTo(Number(saved.fastJevMinConfidence), 0.7, 1e-9)
    assert.closeTo(Number(saved.fastJevMinEdgePct), 0.2, 1e-9)
    assert.equal(Number(saved.fastJevTimeoutMs), 1500)
    assert.isFalse(!!saved.fastJevShadowOnly)
  })
})
