import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { FastAlgoService } from '../../app/services/FastAlgoService.js'
import AlgoConfig from '../../app/models/AlgoConfig.js'
import AlgoPosition from '../../app/models/AlgoPosition.js'
import Ticker from '../../app/models/Ticker.js'
import Trade from '../../app/models/Trade.js'
import KrakenService from '../../app/services/KrakenService.js'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import { FastStrategy } from '../../app/services/FastStrategy.js'
import MeilisearchService from '../../app/services/MeilisearchService.js'
import NotificationService from '../../app/services/NotificationService.js'

// FastAlgoService orchestration tests. Runs against the throwaway unit DB
// (see bin/test.ts / tests/bootstrap.ts); the engine, WS and Kraken portfolio
// are fakes — only the decision loop + persistence are under test.

let tickerSeq = 1
let tradeSeq = 1
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
  const defaultTickerId = opts.tickerId ?? btcTickerId
  const engine: any = {
    running: false,
    cancelled: [] as string[],
    orders: [] as any[],
    tickerId: null,
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
    /**
     * The real KrakenFastEngine persists a trade row per order and links the
     * algo position to it via entryTradeId (FK to trades.id). The fake does
     * the same so the service's position inserts satisfy the constraint.
     */
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
        tickerId: engine.tickerId ?? defaultTickerId,
      }
      engine.states.push(state)
      await engine.persistTrade(state, state.tickerId, order.symbol, order.side, order.orderType, order.quantity)
      return state
    },
    states: [] as any[],
    nextState: (patch: Record<string, any> = {}) => {
      const state = {
        ...patch,
        clientOrderId: `co-${++tradeSeq}`,
        status: 'submitted',
        fillPrice: null,
        tradeId: null,
        tickerId: engine.tickerId ?? defaultTickerId,
      }
      engine.states.push(state)
      return state
    },
  }
  return engine
}

function makeFeed() {
  return new MomentumFeed()
}

function makeStrategy() {
  return new FastStrategy()
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
    fastTrendSlopePct: 0,
    fastTrendSlopeWindowSeconds: 0,
    fastRegimeEmaPeriod: 0,
    fastRegimeSlopeWindowSeconds: 0,
    fastRegimeSlopeMinPct: 0,
    fastVolumeWindowSeconds: 0,
    fastVolumeMinRatio: 0,
    fastCorrelatedExposurePct: 0.35,
    fastRiskPerTradePct: 0,
    fastMaxLossStreak: 0,
    fastLossStreakPauseSeconds: 0,
    fastTrailingVolatilityMult: 0,
    fastScaleOutPct: 0,
    fastMakerExecution: 0,
    fastLimitFillSeconds: 15,
    fastLimitOffsetPct: 0.05,
    fastMakerFeePct: 0.0008,
    fastVolTargetPct: 0,
    fastVolTargetWindowSeconds: 3600,
    fastVolTargetMaxMult: 2,
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

async function makeTrade(opts: Partial<Record<string, any>> = {}): Promise<Trade> {
  const ticker = opts.ticker ?? (await makeTicker(String(opts.symbol ?? 'BTC')))
  return Trade.create({
    tickerId: ticker.id,
    symbol: opts.symbol ?? 'BTC',
    side: opts.side ?? 'BUY',
    orderType: opts.orderType ?? 'MKT',
    quantity: opts.quantity ?? 0.5,
    status: opts.status ?? 'filled',
    fillPrice: opts.fillPrice ?? null,
    errorMessage: opts.errorMessage ?? null,
    exchange: 'SMART',
  })
}

async function makePosition(opts: Record<string, any> = {}): Promise<AlgoPosition> {
  const ticker = opts.ticker ?? (await makeTicker(String(opts.symbol ?? 'BTC')))
  const entryTrade = opts.entryTrade ?? (await makeTrade({ symbol: opts.symbol ?? 'BTC', side: 'BUY', ticker }))
  return AlgoPosition.create({
    tickerId: ticker.id,
    symbol: opts.symbol ?? 'BTC',
    side: opts.side ?? 'BUY',
    quantity: opts.quantity ?? 0.5,
    entryPrice: opts.entryPrice ?? 100,
    currentPrice: opts.currentPrice ?? 100,
    stopLoss: opts.stopLoss ?? 99,
    takeProfit: opts.takeProfit ?? 105,
    entryScore: 1,
    entryConviction: 0.5,
    entryRegime: 'momentum',
    entryReason: 'test',
    entryTradeId: entryTrade.id,
    status: opts.status ?? 'open',
    forceClose: opts.forceClose ?? false,
    scaledOut: opts.scaledOut ?? false,
    peakPrice: opts.peakPrice ?? 100,
    decisionPrice: opts.decisionPrice ?? null,
    exitTradeId: opts.exitTradeId ?? opts.exitTrade?.id ?? null,
    exitReason: opts.exitReason ?? null,
    closedAt: opts.closedAt ?? null,
    realizedPnl: opts.realizedPnl ?? null,
    openedAt: opts.openedAt ?? DateTime.now(),
  })
}

/** Push a steadily rising 1s series into the feed and set the WS price. */
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

async function newService(engine: any, ws: any) {
  const feed = makeFeed()
  const service = new FastAlgoService({ engine, ws, feed, strategy: makeStrategy() })
  return { service, feed }
}

test.group('FastAlgoService', (group) => {
  const origIsConnected = Object.getOwnPropertyDescriptor(KrakenService, 'isConnected')
  const origGetTradeBalance = (KrakenService as any).getTradeBalance
  const origSaveDecision = (MeilisearchService as any).saveDecision
  const origEmit = (NotificationService as any).emit

  group.setup(async () => {
    // Portfolio value + decision logging bypassed with stubs.
    Object.defineProperty(KrakenService, 'isConnected', { value: true, configurable: true })
    ;(KrakenService as any).getTradeBalance = async () => ({ eb: '10000' })
    ;(MeilisearchService as any).saveDecision = async () => {}
    ;(NotificationService as any).emit = async () => {}
    await seedConfig()
  })

  group.teardown(async () => {
    // Restore singletons — other spec files share the module graph.
    if (origIsConnected) {
      Object.defineProperty(KrakenService, 'isConnected', origIsConnected)
    } else {
      delete (KrakenService as any).isConnected
    }
    ;(KrakenService as any).getTradeBalance = origGetTradeBalance
    ;(MeilisearchService as any).saveDecision = origSaveDecision
    ;(NotificationService as any).emit = origEmit
  })

  group.each.setup(async () => {
    tickerSeq = 1
    tradeSeq = 1
    await AlgoPosition.query().delete()
    await Trade.query().delete()
    await Ticker.query().delete()
    btcTickerId = (await Ticker.create({ symbol: 'BTC', name: 'Bitcoin', isActive: true })).id
    await Ticker.create({ symbol: 'ETH', name: 'Ethereum', isActive: true })
    await Ticker.create({ symbol: 'SOL', name: 'Solana', isActive: true })
    await seedConfig()
  })

  group.each.teardown(async () => {
    for (const s of ['BTC', 'ETH', 'SOL']) {
      await Ticker.query().where('symbol', s).delete()
    }
  })

  // ── Lifecycle ──────────────────────────────────────────────

  test('start/stop toggles running and clears the feed', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service, feed } = await newService(engine, ws)
    feed.push('BTC', 100)

    assert.isFalse(service.running)
    service.start()
    assert.isTrue(service.running)
    service.stop()
    assert.isFalse(service.running)
    assert.equal((feed as any).samples?.('BTC') ?? 0, 0)
  })

  // ── tick() gating ──────────────────────────────────────────

  test('tick is a no-op when the algo is disabled', async ({ assert }) => {
    await seedConfig({ enabled: false })
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)

    await (service as any).tick()
    assert.equal(engine.orders.length, 0)
    assert.isFalse(engine.running)
  })

  test('tick is a no-op when fast mode is disabled', async ({ assert }) => {
    await seedConfig({ fastEnabled: false })
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)

    await (service as any).tick()
    assert.equal(engine.orders.length, 0)
  })

  test('tick starts the engine automatically when not running', async ({ assert }) => {
    const engine = makeEngine()
    engine.running = false
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)

    await (service as any).tick()
    assert.isTrue(engine.running)
  })

  test('tick records lastTickError when the engine start fails', async ({ assert }) => {
    const engine = makeEngine()
    engine.start = async () => {
      throw new Error('kraken down')
    }
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)

    await (service as any).tick()
    assert.isNotNull(service.status().lastTickError)
  })

  test('daily loss breach disables the config and blocks trading', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)

    const loser = await makeTrade({ symbol: 'BTC', side: 'SELL' })
    await makePosition({
      symbol: 'BTC', side: 'BUY', status: 'closed', exitTradeId: loser.id,
      realizedPnl: -800, closedAt: DateTime.now(), entryPrice: 100, quantity: 1,
    })

    const cfg = await seedConfig({ dailyLossLimitPct: 0.05 })
    const breached = await (service as any).dailyLossBreached(cfg)
    assert.isTrue(breached)
    const reloaded = await AlgoConfig.find(1)
    assert.isFalse(!!reloaded?.enabled)
    assert.match(reloaded?.disabledReason ?? '', /circuit_breaker/)
  })

  test('daily loss within limit keeps trading', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)

    const cfg = await seedConfig({ dailyLossLimitPct: 0.05 })
    const breached = await (service as any).dailyLossBreached(cfg)
    assert.isFalse(breached)
  })

  // ── Entries ────────────────────────────────────────────────

  test('burst entry places a MARKET order and persists a pending position', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig()
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 1)
    assert.equal(engine.orders[0].orderType, 'MARKET')
    const pos = await AlgoPosition.query().where('symbol', 'BTC').first()
    assert.isNotNull(pos)
    assert.equal(pos?.status, 'pending_entry')
    assert.isNotNull(pos?.entryTradeId)
  })

  test('entry records decision price and levels derived from the signal price', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    const price = pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig()
    await (service as any).checkEntries(cfg, new Set())

    const pos = await AlgoPosition.query().where('symbol', 'BTC').first()
    assert.isNotNull(pos)
    // MARKET entries fill at the decision price -> decision == entry, levels unscaled.
    assert.equal(pos?.decisionPrice, price)
    assert.equal(pos?.entryPrice, price)
    assert.closeTo(pos?.stopLoss ?? 0, price * (1 - 0.005), 1e-4)
    assert.closeTo(pos?.takeProfit ?? 0, price * (1 + 0.015), 1e-4)
  })

  test('entry without a trade id cancels the order and creates no position', async ({ assert }) => {
    const engine = makeEngine()
    engine.placeOrder = async (order: any) => {
      const state = {
        ...order,
        clientOrderId: `co-${++tradeSeq}`,
        status: 'error',
        fillPrice: null,
        tradeId: null,
        externalOrderId: 'ext-order-1',
        tickerId: engine.tickerId ?? btcTickerId,
      }
      engine.states.push(state)
      return state
    }
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig()
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.cancelled.length, 1)
    assert.isNull(await AlgoPosition.query().where('symbol', 'BTC').first())
  })

  test('entry without a ticker id creates no position', async ({ assert }) => {
    const engine = makeEngine()
    engine.placeOrder = async (order: any) => {
      const state = {
        ...order,
        clientOrderId: `co-${++tradeSeq}`,
        status: 'filled',
        fillPrice: 100,
        tradeId: ++tradeSeq,
        tickerId: null,
      }
      engine.states.push(state)
      return state
    }
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig()
    await (service as any).checkEntries(cfg, new Set())

    assert.isNull(await AlgoPosition.query().where('symbol', 'BTC').first())
  })

  test('dry run logs the decision without placing an order', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)
    let decisions: any[] = []
    ;(MeilisearchService as any).saveDecision = async (d: any) => {
      decisions.push(d)
    }

    const cfg = await seedConfig({ dryRun: true })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 0)
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].decision, 'enter')
  })

  test('no live price -> no entry', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({}) // no price
    const { service } = await newService(engine, ws)

    const cfg = await seedConfig()
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 0)
  })

  test('cooldown blocks re-entry on the same symbol', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastCooldownSeconds: 3600 })
    await (service as any).checkEntries(cfg, new Set())
    assert.equal(engine.orders.length, 1)

    await (service as any).checkEntries(cfg, new Set())
    assert.equal(engine.orders.length, 1)
  })

  test('max positions cap prevents further entries', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100, ETH: 200, SOL: 150 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)
    pumpRising(service, 'ETH', 60, 200, 0.02)
    pumpRising(service, 'SOL', 60, 150, 0.02)

    const cfg = await seedConfig({ fastWatchlist: ['BTC', 'ETH', 'SOL'], maxPositions: 2 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 2)
  })

  test('correlated exposure cap stops entries at the basket limit', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100, ETH: 200 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)
    pumpRising(service, 'ETH', 60, 200, 0.02)

    const cfg = await seedConfig({
      fastWatchlist: ['BTC', 'ETH'],
      fastCorrelatedExposurePct: 0.1,
      maxSinglePositionPct: 0.15,
    })
    await (service as any).checkEntries(cfg, new Set())

    // One entry consumes 10% (portfolio $10k, $1500/100 => 15% -> capped at 10% basket)
    assert.equal(engine.orders.length, 1)
  })

  test('risk-per-trade sizing caps the position size', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    // SL 0.5% with risk 0.1% -> sizePct <= 0.2
    const cfg = await seedConfig({ fastRiskPerTradePct: 0.1, maxSinglePositionPct: 0.8 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 1)
    const qty = engine.orders[0].quantity
    const sizePct = (qty * 100) / 10000
    assert.isAtMost(sizePct, 0.2 + 1e-6)
  })

  test('volatility targeting scales position size up to the cap', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    // Low realized vol -> multiplier hits the max (2x), capped by maxSingle.
    const cfg = await seedConfig({
      fastVolTargetPct: 50,
      fastVolTargetWindowSeconds: 60,
      fastVolTargetMaxMult: 2,
      maxSinglePositionPct: 0.3,
    })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 1)
    const qty = engine.orders[0].quantity
    // 15% base (≈14.8) scaled up by the vol multiplier, capped at 30% (≈29.6).
    assert.isAbove(qty, 20)
    assert.isAtMost(qty, 30.5)
  })

  test('loss-streak pause blocks entries', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    ;(service as any).lossStreak = 3
    ;(service as any).streakSinceAt = Date.now()
    const cfg = await seedConfig({ fastMaxLossStreak: 3, fastLossStreakPauseSeconds: 3600 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 0)
  })

  test('loss-streak pause expires and resets the streak', async ({ assert }) => {
        const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    ;(service as any).lossStreak = 3
    ;(service as any).streakSinceAt = Date.now() - 7200 * 1000
    const cfg = await seedConfig({ fastMaxLossStreak: 3, fastLossStreakPauseSeconds: 3600 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 1)
    assert.equal((service as any).lossStreak, 0)
  })

  // ── Maker entries ──────────────────────────────────────────

  test('maker entry fills on the first limit attempt', async ({ assert }) => {
    const engine = makeEngine()
    engine.placeOrder = async (order: any) => {
      engine.orders.push(order)
      const state = engine.nextState({ price: order.price })
      setTimeout(() => {
        state.status = 'filled'
        state.fillPrice = order.price
        void engine.persistTrade(state, state.tickerId, order.symbol, order.side, order.orderType, order.quantity)
      }, 10)
      return state
    }
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastMakerExecution: 1, fastLimitFillSeconds: 2 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 1)
    assert.equal(engine.orders[0].orderType, 'LIMIT')
    const pos = await AlgoPosition.query().where('symbol', 'BTC').first()
    assert.isNotNull(pos)
    assert.equal(pos?.status, 'pending_entry')
  })

  test('maker entry retries once with a fresh price when the first limit misses', async ({ assert }) => {
    const engine = makeEngine()
    let attempt = 0
    engine.placeOrder = async (order: any) => {
      engine.orders.push(order)
      const state = engine.nextState({ price: order.price })
      attempt++
      if (attempt === 2) {
        setTimeout(() => {
          state.status = 'filled'
          state.fillPrice = order.price
          void engine.persistTrade(state, state.tickerId, order.symbol, order.side, order.orderType, order.quantity)
        }, 10)
      } else {
        setTimeout(() => {
          state.status = 'cancelled'
        }, 10)
      }
      return state
    }
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastMakerExecution: 1, fastLimitFillSeconds: 2 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 2)
    assert.equal(engine.cancelled.length, 1)
    const pos = await AlgoPosition.query().where('symbol', 'BTC').first()
    assert.isNotNull(pos)
    assert.equal(pos?.status, 'pending_entry')
  })

  test('maker entry skips after both attempts miss', async ({ assert }) => {
    const engine = makeEngine()
    let decisions: any[] = []
    ;(MeilisearchService as any).saveDecision = async (d: any) => {
      decisions.push(d)
    }
    engine.placeOrder = async (order: any) => {
      engine.orders.push(order)
      const state = engine.nextState({ price: order.price })
      setTimeout(() => {
        state.status = 'cancelled'
      }, 10)
      return state
    }
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    pumpRising(service, 'BTC', 60, 100, 0.02)

    const cfg = await seedConfig({ fastMakerExecution: 1, fastLimitFillSeconds: 2 })
    await (service as any).checkEntries(cfg, new Set())

    assert.equal(engine.orders.length, 2)
    assert.equal(engine.cancelled.length, 2)
    assert.isNull(await AlgoPosition.query().where('symbol', 'BTC').first())
    assert.equal(decisions.filter((d) => d.decision === 'skip').length, 1)
  })

  // ── Exits ──────────────────────────────────────────────────

  test('force close exits via MARKET and moves the position to closing', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    const pos = await makePosition({ status: 'open', forceClose: true })

    const cfg = await seedConfig()
    await (service as any).checkExit(pos, cfg)

    assert.equal(engine.orders.length, 1)
    assert.equal(engine.orders[0].side, 'SELL')
    assert.equal(engine.orders[0].orderType, 'MARKET')
    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.status, 'closing')
    assert.match(reloaded?.exitReason ?? '', /force close/)
  })

  test('stop-loss exit triggers on live price breach', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 95 })
    const { service } = await newService(engine, ws)
    const pos = await makePosition({ status: 'open', stopLoss: 99, takeProfit: 105 })

    const cfg = await seedConfig()
    await (service as any).checkExit(pos, cfg)

    assert.equal(engine.orders.length, 1)
    const reloaded = await AlgoPosition.find(pos.id)
    assert.match(reloaded?.exitReason ?? '', /stop[- ]loss/i)
  })

  test('trailing stop is persisted on the position while holding', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 103 })
    const { service } = await newService(engine, ws)
    // Rising series so the trail arms: peak = 105 (from pump), price 103.
    pumpRising(service, 'BTC', 60, 100, 0.02)
    const pos = await makePosition({
      status: 'open', entryPrice: 100, stopLoss: 90, takeProfit: 0,
      peakPrice: 100, side: 'BUY',
    })

    const cfg = await seedConfig({
      fastTrailingStopPct: 0.5,
      fastTrailingActivatePct: 0.5,
      fastStopLossPct: 10,
    })
    await (service as any).checkExit(pos, cfg)

    const reloaded = await AlgoPosition.find(pos.id)
    assert.isNotNull(reloaded)
    // Trail armed (price > entry * 1.005) -> stop tightened from 90.
    assert.isAbove(reloaded?.stopLoss ?? 0, 90)
  })

  test('exit without a trade id cancels the sell order and stays open', async ({ assert }) => {
    const engine = makeEngine()
    engine.placeOrder = async (order: any) => {
      const state = {
        ...order,
        clientOrderId: `co-${++tradeSeq}`,
        status: 'error',
        tradeId: null,
        externalOrderId: 'ext-order-1',
        tickerId: engine.tickerId ?? btcTickerId,
      }
      engine.states.push(state)
      return state
    }
    const ws = makeWs({ BTC: 95 })
    const { service } = await newService(engine, ws)
    const pos = await makePosition({ status: 'open', stopLoss: 99, takeProfit: 105 })

    const cfg = await seedConfig()
    await (service as any).checkExit(pos, cfg)

    assert.equal(engine.cancelled.length, 1)
    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.status, 'open')
  })

  test('scale-out sells the configured fraction and records partial PnL', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 103 })
    const { service } = await newService(engine, ws)
    const pos = await makePosition({ status: 'open', quantity: 1, entryPrice: 100 })

    const cfg = await seedConfig({ fastScaleOutPct: 0.5 })
    await (service as any).scaleOutPosition(pos, 103, cfg)

    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.quantity, 0.5)
    assert.equal(reloaded?.scaledOut, 1)
    assert.closeTo(reloaded?.scaledOutPnl ?? 0, 1.5, 1e-6)
  })

  // ── Reconcile ──────────────────────────────────────────────

  test('reconcile promotes a filled pending entry to open with fill price', async ({ assert }) => {
    const ws = makeWs({ BTC: 100 })
    const engine = makeEngine()
    const { service } = await newService(engine, ws)

    const entryTrade = await makeTrade({ symbol: 'BTC', side: 'BUY', status: 'filled', fillPrice: 99.5 })
    const pos = await makePosition({ status: 'pending_entry', entryTrade, entryPrice: 100 })

    const cfg = await seedConfig()
    await (service as any).reconcile(cfg)

    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.status, 'open')
    assert.equal(reloaded?.entryPrice, 99.5)
  })

  test('reconcile closes a pending entry whose trade errored', async ({ assert }) => {
    const ws = makeWs({ BTC: 100 })
    const engine = makeEngine()
    const { service } = await newService(engine, ws)

    const entryTrade = await makeTrade({ symbol: 'BTC', side: 'BUY', status: 'error', errorMessage: 'rejected' })
    const pos = await makePosition({ status: 'pending_entry', entryTrade })

    const cfg = await seedConfig()
    await (service as any).reconcile(cfg)

    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.status, 'closed')
    assert.match(reloaded?.exitReason ?? '', /error/)
  })

  test('reconcile closes a filled exit with realized PnL and bumps the loss streak', async ({ assert }) => {
    const ws = makeWs({ BTC: 100 })
    const engine = makeEngine()
    const { service } = await newService(engine, ws)

    const exitTrade = await makeTrade({ symbol: 'BTC', side: 'SELL', status: 'filled', fillPrice: 98 })
    const pos = await makePosition({ status: 'closing', exitTrade, entryPrice: 100, quantity: 1, side: 'BUY' })

    const cfg = await seedConfig()
    await (service as any).reconcile(cfg)

    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.status, 'closed')
    assert.closeTo(reloaded?.realizedPnl ?? 0, -2, 1e-6)
    assert.equal((service as any).lossStreak, 1)
  })

  test('reconcile resets the loss streak on a winning close', async ({ assert }) => {
    const ws = makeWs({ BTC: 100 })
    const engine = makeEngine()
    const { service } = await newService(engine, ws)
    ;(service as any).lossStreak = 2

    const exitTrade = await makeTrade({ symbol: 'BTC', side: 'SELL', status: 'filled', fillPrice: 104 })
    const pos = await makePosition({ status: 'closing', exitTrade, entryPrice: 100, quantity: 1, side: 'BUY' })

    const cfg = await seedConfig()
    await (service as any).reconcile(cfg)

    assert.equal((service as any).lossStreak, 0)
  })

  test('reconcile returns a failed exit to open', async ({ assert }) => {
    const ws = makeWs({ BTC: 100 })
    const engine = makeEngine()
    const { service } = await newService(engine, ws)

    const exitTrade = await makeTrade({ symbol: 'BTC', side: 'SELL', status: 'error', errorMessage: 'rejected' })
    const pos = await makePosition({ status: 'closing', exitTrade, exitTradeId: exitTrade.id })

    const cfg = await seedConfig()
    await (service as any).reconcile(cfg)

    const reloaded = await AlgoPosition.find(pos.id)
    assert.equal(reloaded?.status, 'open')
    assert.isNull(reloaded?.exitTradeId)
  })

  // ── Stats / status ─────────────────────────────────────────

  test('getStats computes PF, win rate and drawdown from closed positions', async ({ assert }) => {
    const ws = makeWs({ BTC: 100 })
    const engine = makeEngine()
    const { service } = await newService(engine, ws)

    for (const [pnl, days] of [
      [200, 2], [-100, 1], [300, 3], [-50, 1],
    ] as Array<[number, number]>) {
      const ticker = await makeTicker('BTC')
      const trade = await Trade.create({
        tickerId: ticker.id, symbol: 'BTC', side: 'SELL', orderType: 'MKT',
        quantity: 1, status: 'filled', exchange: 'SMART',
      })
      await AlgoPosition.create({
        tickerId: ticker.id, symbol: 'BTC', side: 'BUY', quantity: 1,
        entryPrice: 100, currentPrice: 100, stopLoss: 90, takeProfit: 110,
        entryScore: 1, entryConviction: 0.5, entryRegime: 'momentum', entryReason: 't',
        entryTradeId: trade.id, status: 'closed', forceClose: false, scaledOut: false,
        realizedPnl: pnl, closedAt: DateTime.now(),
        openedAt: DateTime.now().minus({ days }),
      })
    }

    const stats = await service.getStats()
    assert.equal(stats.totalTrades, 4)
    assert.equal(stats.winCount, 2)
    assert.equal(stats.winRate, 0.5)
    assert.equal(stats.totalPnl, 350)
    assert.equal(stats.profitFactor, 500 / 150)
    assert.isAbove(stats.maxDrawdown, 0)
  })

  test('status reflects running state, watchlist and cooldowns', async ({ assert }) => {
    const engine = makeEngine()
    engine.running = true
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    const fakeTimer = setInterval(() => {}, 1000)
    ;(service as any).loopTimer = fakeTimer
    await seedConfig({ fastWatchlist: ['BTC', 'ETH'] })
    await (service as any).getConfig()
    ;(service as any).symbolCooldowns.set('BTC', Date.now())
    ;(service as any).lastTickAt = 12345

    const status = service.status()
    assert.isTrue(status.running)
    assert.isTrue(status.engineRunning)
    assert.equal(status.watchlist.length, 2)
    assert.deepEqual(status.cooldowns, ['BTC'])
    assert.equal(status.lastTickAt, 12345)
    clearInterval(fakeTimer)
    ;(service as any).loopTimer = null
  })

  test('waitForFill times out and returns null when the order never fills', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    const state = engine.nextState({})

    const fill = await (service as any).waitForFill(state, 50)
    assert.isNull(fill)
  })

  test('waitForFill returns the fill price once the order fills', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    const state = engine.nextState({})
    setTimeout(() => {
      state.status = 'filled'
      state.fillPrice = 99.5
    }, 10)

    const fill = await (service as any).waitForFill(state, 2000)
    assert.equal(fill, 99.5)
  })

  test('getPortfolioValue serves from cache within the TTL', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    const cfg = await seedConfig()
    let calls = 0
    ;(KrakenService as any).getTradeBalance = async () => {
      calls++
      return { eb: '10000' }
    }

    const first = await (service as any).getPortfolioValue(cfg)
    const second = await (service as any).getPortfolioValue(cfg)
    assert.equal(first, 10000)
    assert.equal(second, 10000)
    assert.equal(calls, 1)
  })

  test('logDecision swallows Meilisearch failures', async ({ assert }) => {
    const engine = makeEngine()
    const ws = makeWs({ BTC: 100 })
    const { service } = await newService(engine, ws)
    ;(MeilisearchService as any).saveDecision = async () => {
      throw new Error('meili down')
    }

    await assert.doesNotReject(() => (service as any).logDecision('BTC', 1, 'enter', 'test', {}))
  })
})
