import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { BacktestEngine, BacktestConfig, BacktestSample } from '../../app/services/BacktestEngine.js'
import { FastStrategyConfig } from '../../app/services/FastStrategy.js'
import { loadJevEvents, pruneMlScores } from '../../app/services/backtest_data.js'
import { JevDecisionService } from '../../app/services/JevDecisionService.js'
import { FastAlgoService } from '../../app/services/FastAlgoService.js'
import { MomentumFeed } from '../../app/services/MomentumFeed.js'
import { FastStrategy } from '../../app/services/FastStrategy.js'
import AlgoConfig from '../../app/models/AlgoConfig.js'
import AlgoPosition from '../../app/models/AlgoPosition.js'
import Ticker from '../../app/models/Ticker.js'
import Trade from '../../app/models/Trade.js'
import KrakenService from '../../app/services/KrakenService.js'
import MeilisearchService from '../../app/services/MeilisearchService.js'
import NotificationService from '../../app/services/NotificationService.js'

// U4 recorded-score replay: stored Jev scores replay through the same
// strategy code at live cadence with point-in-time discipline. Engine
// sections are pure and synthetic; loader/prune sections use the throwaway
// unit DB (ml_scores exists via migration 28).

const engine = new BacktestEngine()

const T0 = 1_700_000_000_000

function series(priceFn: (i: number) => number, count: number): BacktestSample[] {
  return Array.from({ length: count }, (_, i) => ({ t: T0 + i * 1000, p: priceFn(i) }))
}

function strategy(overrides: Partial<FastStrategyConfig> = {}): FastStrategyConfig {
  return {
    momentumSeconds: 60,
    momentumThresholdPct: 0.1,
    rsiLow: 0,
    rsiHigh: 1000,
    stopLossPct: 0.5,
    takeProfitPct: 1.5,
    exitReversalPct: -0.3,
    trailingStopPct: 0,
    trailingActivatePct: 0,
    maxHoldSeconds: 0,
    emaPeriod: 0,
    volatilityWindowSamples: 0,
    volatilityMult: 0,
    volatilityFloorPct: 0.05,
    volatilityCeilingPct: 0,
    harVolForecast: false,
    cusumWindowSeconds: 0,
    cusumExitPct: 0,
    jumpSlackPct: 0,
    choppinessPeriod: 0,
    choppinessMax: 0,
    tradeStartUtc: 0,
    tradeEndUtc: 24,
    convictionSizing: false,
    newsGateEnabled: false,
    newsMinSentiment: 0,
    newsMinArticles: 3,
    newsWindowSeconds: 86400,
    ...overrides,
  }
}

function baseCfg(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'BTC',
    strategy: strategy(),
    loopIntervalSeconds: 10,
    portfolioUsd: 10_000,
    feePct: 0.001,
    maxPositions: 1,
    maxExposurePct: 0.8,
    maxSinglePositionPct: 0.2,
    cooldownSeconds: 30,
    ...overrides,
  }
}

function bearishEvent(t: number, overrides: Record<string, any> = {}) {
  return {
    t,
    pUp: 0.2,
    pDown: 0.72,
    confidence: 0.8,
    model: 'jev-1.13.0',
    questionHash: 'q1',
    ...overrides,
  }
}

const rising = () => series((i) => 100 * Math.pow(1.0001, i), 2 * 3600)

// Per-minute enforced events across the window — replay only sees scores
// younger than the 90s reuse window, so single-event fixtures would
// correctly replay as scoreless after the first ticks.
function denseEvents(startMs: number, endMs: number, overrides: Record<string, any> = {}) {
  const events = []
  for (let t = startMs; t <= endMs; t += 60_000) events.push(bearishEvent(t, overrides))
  return events
}

const denseVeto = () => denseEvents(T0 - 60_000, T0 + 2 * 3600_000)

test.group('Jev replay determinism and gating', () => {
  test('recorded bearish scores veto entries the deterministic run takes', ({ assert }) => {
    const samples = rising()
    const plain = engine.run(samples, baseCfg())
    assert.isAbove(plain.metrics.totalTrades, 0)

    const vetoed = engine.run(
      samples,
      baseCfg({
        strategy: strategy({ jevGateEnabled: true }),
        jevEvents: denseVeto(),
      })
    )
    assert.equal(vetoed.metrics.totalTrades, 0)
  })

  test('identical bars plus identical scores reproduce identical reports', ({ assert }) => {
    const samples = rising()
    const cfg = baseCfg({
      strategy: strategy({ jevGateEnabled: true }),
      jevEvents: [bearishEvent(T0), bearishEvent(T0 + 3600_000)],
    })
    const first = engine.run(samples, cfg)
    const second = engine.run(samples, cfg)
    assert.deepEqual(second.metrics, first.metrics)
    assert.deepEqual(second.trades, first.trades)
  })

  test('gate on with no recorded scores runs off with a notice', ({ assert }) => {
    const samples = rising()
    const plain = engine.run(samples, baseCfg())
    const gated = engine.run(samples, baseCfg({ strategy: strategy({ jevGateEnabled: true }) }))
    assert.isNotNull(gated.jevNotice)
    assert.match(gated.jevNotice!, /no recorded Jev scores/i)
    assert.deepEqual(gated.metrics, plain.metrics)
  })

  test('scores timestamped after the window are invisible', ({ assert }) => {
    const samples = rising()
    const plain = engine.run(samples, baseCfg())
    const late = engine.run(
      samples,
      baseCfg({
        strategy: strategy({ jevGateEnabled: true }),
        jevEvents: [bearishEvent(T0 + 10 * 3600_000)],
      })
    )
    assert.deepEqual(late.metrics, plain.metrics)
  })

  test('a pre-window score governs from the first decision', ({ assert }) => {
    const samples = rising()
    // Dense from just before the window — the opening score is pre-window
    // (60s old at the first decision) and coverage never lapses after.
    const vetoed = engine.run(
      samples,
      baseCfg({
        strategy: strategy({ jevGateEnabled: true }),
        jevEvents: denseVeto(),
      })
    )
    assert.equal(vetoed.metrics.totalTrades, 0)
  })

  test('shadow-recorded scores replay as non-enforcing', ({ assert }) => {
    const samples = rising()
    const plain = engine.run(samples, baseCfg())
    const shadow = engine.run(
      samples,
      baseCfg({
        strategy: strategy({ jevGateEnabled: true }),
        jevEvents: [bearishEvent(T0, { enforced: false })],
      })
    )
    assert.deepEqual(shadow.metrics, plain.metrics)
  })

  test('mixed model versions are rejected instead of blended', ({ assert }) => {
    const samples = rising()
    const run = () =>
      engine.run(
        samples,
        baseCfg({
          strategy: strategy({ jevGateEnabled: true }),
          jevEvents: [bearishEvent(T0), bearishEvent(T0 + 1000, { model: 'jev-1.14.0' })],
        })
      )
    assert.throws(run, /model|version|blend/i)
  })

  test('mixed prompt versions are rejected instead of blended', ({ assert }) => {
    const samples = rising()
    const run = () =>
      engine.run(
        samples,
        baseCfg({
          strategy: strategy({ jevGateEnabled: true }),
          jevEvents: [bearishEvent(T0), bearishEvent(T0 + 1000, { promptVersion: 'v2' })],
        })
      )
    assert.throws(run, /model|version|blend|prompt/i)
  })

  test('an all-shadow list runs the gate off with a notice', ({ assert }) => {
    const samples = rising()
    const plain = engine.run(samples, baseCfg())
    const shadow = engine.run(
      samples,
      baseCfg({
        strategy: strategy({ jevGateEnabled: true }),
        jevEvents: [bearishEvent(T0, { enforced: false })],
      })
    )
    assert.deepEqual(shadow.metrics, plain.metrics)
    assert.isNotNull(shadow.jevNotice)
    assert.match(shadow.jevNotice!, /no recorded Jev scores/i)
  })

  test('passing reads shrink size without vetoing', ({ assert }) => {
    const samples = rising()
    const plain = engine.run(samples, baseCfg())
    assert.isAbove(plain.trades.length, 0)
    // Edge 0.05 < 0.15 floor: no veto. Confidence 0.9 maps to 0.9× size.
    // Dense per-minute so the sizing read stays fresh for every entry.
    const passing = { pUp: 0.45, pDown: 0.5, confidence: 0.9, model: 'jev-1.13.0', questionHash: 'q1' }
    const shrunk = engine.run(
      samples,
      baseCfg({
        strategy: strategy({ jevGateEnabled: true }),
        jevEvents: denseEvents(T0 - 60_000, T0 + 2 * 3600_000, passing),
      })
    )
    assert.equal(shrunk.trades.length, plain.trades.length)
    assert.closeTo(shrunk.trades[0].quantity / plain.trades[0].quantity, 0.9, 0.01)
  })
})

test.group('Jev score loading and pruning', () => {
  test('loads in-window non-fixture rows ordered by time', async ({ assert }) => {
    await db.from('ml_scores').del()
    await db.table('ml_scores').insert([
      { symbol: 'BTC', decided_at: T0 + 2000, model: 'jev-1.13.0', question_hash: 'q1', prompt_version: 'v1', window_seconds: 0, p_up: 0.3, p_down: 0.6, confidence: 0.7, latency_ms: 120, stale: false, fixture: false },
      { symbol: 'BTC', decided_at: T0 + 1000, model: 'jev-1.13.0', question_hash: 'q1', prompt_version: 'v1', window_seconds: 0, p_up: 0.4, p_down: 0.5, confidence: 0.6, latency_ms: 110, stale: false, fixture: false },
      { symbol: 'BTC', decided_at: T0 + 1500, model: 'jev-1.13.0', question_hash: 'q1', prompt_version: 'v1', window_seconds: 0, p_up: 0.9, p_down: 0.05, confidence: 0.95, latency_ms: 100, stale: false, fixture: true },
      { symbol: 'BTC', decided_at: T0 - 99 * 3600_000, model: 'jev-1.13.0', question_hash: 'q1', prompt_version: 'v1', window_seconds: 0, p_up: 0.1, p_down: 0.8, confidence: 0.9, latency_ms: 100, stale: false, fixture: false },
      { symbol: 'ETH', decided_at: T0 + 1000, model: 'jev-1.13.0', question_hash: 'q1', prompt_version: 'v1', window_seconds: 0, p_up: 0.5, p_down: 0.4, confidence: 0.6, latency_ms: 100, stale: false, fixture: false },
    ])

    const events = await loadJevEvents('BTC', T0, T0 + 3600_000)
    assert.equal(events.length, 2)
    assert.isTrue(events[0].t < events[1].t)
    assert.closeTo(events[0].pDown, 0.5, 1e-9)
    assert.equal(events[0].model, 'jev-1.13.0')
    assert.equal(events[0].questionHash, 'q1')
  })

  test('loader maps enforced from the row', async ({ assert }) => {
    await db.from('ml_scores').del()
    await db.table('ml_scores').insert([
      { symbol: 'BTC', decided_at: T0 + 1000, model: 'm', question_hash: 'q', prompt_version: 'v1', window_seconds: 0, p_up: 0.5, p_down: 0.4, confidence: 0.6, latency_ms: 1, stale: false, fixture: false, enforced: false },
      { symbol: 'BTC', decided_at: T0 + 2000, model: 'm', question_hash: 'q', prompt_version: 'v1', window_seconds: 0, p_up: 0.5, p_down: 0.4, confidence: 0.6, latency_ms: 1, stale: false, fixture: false, enforced: true },
    ])
    const events = await loadJevEvents('BTC', T0, T0 + 3600_000)
    assert.equal(events.length, 2)
    assert.isFalse(events[0].enforced)
    assert.isTrue(events[1].enforced)
  })

  test('prunes rows older than the retention cutoff', async ({ assert }) => {
    await db.from('ml_scores').del()
    const old = Date.now() - 200 * 86400_000
    const fresh = Date.now() - 10 * 86400_000
    await db.table('ml_scores').insert([
      { symbol: 'BTC', decided_at: old, model: 'm', question_hash: 'q', prompt_version: 'v1', window_seconds: 0, p_up: 0.5, p_down: 0.4, confidence: 0.6, latency_ms: 1, stale: false, fixture: false },
      { symbol: 'BTC', decided_at: fresh, model: 'm', question_hash: 'q', prompt_version: 'v1', window_seconds: 0, p_up: 0.5, p_down: 0.4, confidence: 0.6, latency_ms: 1, stale: false, fixture: false },
    ])
    const pruned = await pruneMlScores(Date.now() - 90 * 86400_000)
    assert.equal(pruned, 1)
    const remaining = await db.from('ml_scores').select('decided_at')
    assert.equal(remaining.length, 1)
  })

  test('question hash is stable across calls and instances', ({ assert }) => {
    const a = new JevDecisionService({ apiKey: '' })
    const b = new JevDecisionService({ apiKey: '' })
    assert.isTrue(a.getQuestionHash().length > 0)
    assert.equal(a.getQuestionHash(), b.getQuestionHash())
  })
})

test.group('Jev live score recording', (group) => {
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
    await Ticker.create({ symbol: 'BTC', name: 'Bitcoin', isActive: true })
    await db.from('ml_scores').del()
  })

  async function seedLiveConfig(overrides: Record<string, any> = {}) {
    const existing = await AlgoConfig.find(1)
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
      fastMaxPositions: undefined,
      fastJevGateEnabled: true,
      fastJevMinConfidence: 0.5,
      fastJevMinEdgePct: 0.15,
      fastJevTimeoutMs: 2000,
      fastJevShadowOnly: false,
      maxPositions: 5,
      maxExposurePct: 0.8,
      maxSinglePositionPct: 0.15,
      dailyLossLimitPct: 0.05,
      ...overrides,
    }
    delete base.fastMaxPositions
    if (existing) {
      await existing.merge(base).save()
      return (await AlgoConfig.find(1))!
    }
    return AlgoConfig.create(base)
  }

  function liveService(jevService: any) {
    const prices = new Map<string, number>([['BTC', 100]])
    const ws: any = {
      getConnectedSymbols: () => [...prices.keys()],
      getPrice: (s: string) => prices.get(s) ?? null,
      addSymbol: (s: string, p: number | null = null) => {
        if (!prices.has(s)) prices.set(s, p as number)
      },
      setPrice: (s: string, p: number) => prices.set(s, p),
    }
    const states: any[] = []
    const orders: any[] = []
    const engine: any = {
      running: true,
      start: async () => {
        engine.running = true
      },
      stop: async () => {
        engine.running = false
      },
      cancelOrder: async () => {},
      pruneCompletedOrders: () => {},
      placeOrder: async (order: any) => {
        orders.push(order)
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
        const state = { ...order, clientOrderId: `jev-${orders.length}`, status: 'filled', fillPrice: order.price ?? 100, tradeId: trade.id, tickerId: ticker!.id }
        states.push(state)
        return state
      },
    }
    const service = new FastAlgoService({
      engine,
      ws,
      feed: new MomentumFeed(),
      strategy: new FastStrategy(),
      jevService,
      meili: { getAnalysesForTicker: async () => [] },
    })
    return { service, ws, orders }
  }

  function pumpRising(service: any, steps: number, base: number, stepPct: number) {
    const now = Date.now()
    let price = base
    for (let i = 0; i < steps; i++) {
      price = price * (1 + stepPct / 100)
      service.ws.setPrice('BTC', price)
      service.feed.push('BTC', price, now - (steps - 1 - i) * 1000)
    }
    return price
  }

  async function waitForScore(symbol: string, timeoutMs = 3000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const rows = await db.from('ml_scores').where('symbol', symbol)
      if (rows.length > 0) return rows
      await new Promise((r) => setTimeout(r, 50))
    }
    return db.from('ml_scores').where('symbol', symbol)
  }

  test('enforced live scores persist with the full attribution tuple', async ({ assert }) => {
    const jevService = {
      async getDecision(state: any) {
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
      getQuestionHash: () => 'q-live',
    }
    const { service } = liveService(jevService)
    pumpRising(service, 60, 100, 0.02)

    const cfg = await seedLiveConfig()
    await (service as any).checkEntries(cfg, new Set())

    const rows = await waitForScore('BTC')
    assert.isAbove(rows.length, 0)
    const row = rows[0]
    assert.equal(row.model, 'jev-1.13.0')
    assert.equal(row.question_hash, 'q-live')
    assert.closeTo(Number(row.p_down), 0.2, 1e-9)
    assert.closeTo(Number(row.confidence), 0.8, 1e-9)
    assert.isAbove(Number(row.decided_at), 0)
  })

  test('fixture contexts never certify', async ({ assert }) => {
    const jevService = new JevDecisionService({
      apiKey: '',
      fixtures: { BTC: { pUp: 0.62, pDown: 0.3, confidence: 0.7 } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const { service } = liveService(jevService)
    pumpRising(service, 60, 100, 0.02)

    const cfg = await seedLiveConfig()
    await (service as any).checkEntries(cfg, new Set())
    await new Promise((r) => setTimeout(r, 300))

    const rows = await db.from('ml_scores').where('symbol', 'BTC')
    assert.equal(rows.length, 0)
  })
})
