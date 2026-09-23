import { v4 as uuidv4 } from 'uuid'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import AlgoConfig from '#models/AlgoConfig'
import AlgoPosition from '#models/AlgoPosition'
import Ticker from '#models/Ticker'
import KrakenFastEngine from '#services/KrakenFastEngine'
import KrakenService from '#services/KrakenService'
import KrakenWS from '#services/KrakenWebSocketService'
import { MomentumFeed } from '#services/MomentumFeed'
import { FastStrategy, FastStrategyConfig, fastStrategyFromConfig, volatilityMultiplier, NewsContext, JevContext } from '#services/FastStrategy'
import MeilisearchService from '#services/MeilisearchService'
import NotificationService from '#services/NotificationService'
import NewsSentimentService from '#services/NewsSentimentService'
import JevDecisionService from '#services/JevDecisionService'
import JevRollout from '#services/JevRollout'
import IBKRPriceFeed from '#services/IBKRPriceFeed'
import IBKRService from '#services/IBKRService'
import IBKRFastEngine from '#services/IBKRFastEngine'
import type { PriceFeed, FastExecutionEngine, EquityProvider } from '#services/market_types'

// ─── Intraminute algo loop ────────────────────────────────────
//
// Merges the fast trading engine into the algo trading system:
// - runs on a 10s (configurable) decision cycle instead of the 30-min cron
// - entries driven by live price momentum (MomentumFeed over the Kraken WS)
// - exits (SL/TP/reversal/force-close) checked against live WS prices
// - execution goes through KrakenFastEngine (direct REST + WS fills), not
//   the BullMQ slow path
// - position lifecycle tracked in algo_positions, decisions in Meilisearch

const TERMINAL_TRADE_STATUSES = ['filled', 'cancelled', 'error', 'inactive']
const CONFIG_CACHE_MS = 5000
const PORTFOLIO_CACHE_MS = 60000
const ENGINE_START_BACKOFF_MS = 60000
const MIN_LOOP_SECONDS = 5

/**
 * Venue registry — the fast algo composes its price feed, execution engine
 * and equity provider from the algo_configs.broker field. Adding a venue is
 * a new entry here (plus its implementations); FastAlgoService stays venue-
 * free.
 */
const BROKER_COMPONENTS: Record<string, {
  engine: FastExecutionEngine | null
  ws: PriceFeed
  equity: EquityProvider
}> = {
  kraken: {
    engine: KrakenFastEngine,
    ws: KrakenWS,
    equity: KrakenService,
  },
  ibkr: {
    engine: IBKRFastEngine,
    ws: IBKRPriceFeed,
    equity: IBKRService,
  },
}

interface AlgoStats {
  totalTrades: number
  winCount: number
  lossCount: number
  winRate: number
  avgReturnPct: number
  totalPnl: number
  largestWin: number
  largestLoss: number
  avgHoldingDays: number
  profitFactor: number
  maxDrawdown: number
}

export class FastAlgoService {
  private engine: any
  private ws: any
  private feed: MomentumFeed
  private strategy: FastStrategy

  private loopTimer: ReturnType<typeof setInterval> | null = null
  private samplerTimer: ReturnType<typeof setInterval> | null = null
  private loopSeconds = 10

  private lastTickAt: number | null = null
  private lastTickError: string | null = null
  private lastEngineStartAttempt = 0

  // Re-entrancy guard: a tick can outlive the loop interval (maker entries
  // wait for fills up to 15-30s on a 10s loop). Without this, overlapping
  // ticks could double-enter positions.
  private tickInFlight = false

  private configCache: { data: AlgoConfig | null; at: number } = { data: null, at: 0 }
  private portfolioCache: { value: number; at: number } = { value: 0, at: 0 }
  private symbolCooldowns = new Map<string, number>()
  private lossStreak = 0
  private streakSinceAt = 0
  private runId = uuidv4()
  private tickerIdCache: { map: Map<string, number>; at: number } = { map: new Map(), at: 0 }
  /** Venue components resolved from cfg.broker; 'manual' = DI fakes (tests). */
  private components: { engine: FastExecutionEngine | null; ws: PriceFeed; equity: EquityProvider } | null = null
  private componentsKey: string | null = null
  private refusedSwitch: string | null = null

  constructor(opts: {
    engine?: any
    ws?: any
    feed?: MomentumFeed
    strategy?: FastStrategy
    newsService?: any
    jevService?: any
    jevRollout?: any
    meili?: any
    tickerModel?: any
    brokerRegistry?: typeof BROKER_COMPONENTS
  } = {}) {
    this.engine = opts.engine ?? KrakenFastEngine
    this.ws = opts.ws ?? KrakenWS
    this.feed = opts.feed ?? new MomentumFeed()
    this.strategy = opts.strategy ?? new FastStrategy()
    this.newsService = opts.newsService ?? NewsSentimentService
    this.jevService = opts.jevService ?? JevDecisionService
    this.jevRollout = opts.jevRollout ?? JevRollout
    this.meili = opts.meili ?? MeilisearchService
    this.tickerModel = opts.tickerModel ?? Ticker
    this.brokerRegistry = opts.brokerRegistry ?? BROKER_COMPONENTS
    // Explicit DI (unit tests) pins the components; the singleton resolves
    // from the broker registry on the first tick.
    if (opts.engine && opts.ws) {
      this.components = { engine: opts.engine, ws: opts.ws, equity: opts.equity ?? KrakenService }
      this.componentsKey = 'manual'
    }
  }

  private newsService: any
  private jevService: any
  private jevRollout: any
  private meili: any
  private tickerModel: any
  private brokerRegistry: Record<string, { engine: FastExecutionEngine | null; ws: PriceFeed; equity: EquityProvider }>

  public get running(): boolean {
    return this.loopTimer !== null
  }

  // ── Closed-position statistics (moved from the old slow algo loop) ──

  public async getStats(): Promise<AlgoStats> {
    const closed = await AlgoPosition.query()
      .where('status', 'closed')
      .whereNotNull('realized_pnl')
      .orderBy('closed_at', 'asc')

    if (closed.length === 0) {
      return {
        totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
        avgReturnPct: 0, totalPnl: 0, largestWin: 0, largestLoss: 0,
        avgHoldingDays: 0, profitFactor: 0, maxDrawdown: 0,
      }
    }

    let winCount = 0
    let lossCount = 0
    let totalPnl = 0
    let grossWins = 0
    let grossLosses = 0
    let largestWin = 0
    let largestLoss = 0
    let totalReturnPct = 0
    let totalDaysHeld = 0

    // For drawdown calculation: track the equity curve (1.0 + cumulative % returns).
    let equity = 1
    let peakEquity = 1
    let maxDrawdown = 0

    for (const pos of closed) {
      const pnl = (Number(pos.realizedPnl) || 0) + (Number(pos.scaledOutPnl) || 0)
      totalPnl += pnl

      if (pnl > 0) {
        winCount++
        grossWins += pnl
        if (pnl > largestWin) largestWin = pnl
      } else {
        lossCount++
        grossLosses += Math.abs(pnl)
        if (pnl < largestLoss) largestLoss = pnl
      }

      const returnPct = pos.entryPrice > 0 && pos.quantity > 0
        ? (pnl / (pos.entryPrice * pos.quantity)) * 100
        : 0
      totalReturnPct += returnPct

      if (pos.openedAt && pos.closedAt) {
        totalDaysHeld += pos.closedAt.diff(pos.openedAt, 'days').days
      }

      equity += returnPct / 100
      if (equity > peakEquity) peakEquity = equity
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0
      if (dd > maxDrawdown) maxDrawdown = dd
    }

    const totalTrades = closed.length

    return {
      totalTrades,
      winCount,
      lossCount,
      winRate: totalTrades > 0 ? winCount / totalTrades : 0,
      avgReturnPct: totalTrades > 0 ? totalReturnPct / totalTrades : 0,
      totalPnl,
      largestWin,
      largestLoss,
      avgHoldingDays: totalTrades > 0 ? totalDaysHeld / totalTrades : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      maxDrawdown,
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────

  public start(): void {
    if (this.loopTimer) return

    this.samplerTimer = setInterval(() => this.sample(), 1000)
    this.loopTimer = setInterval(() => { void this.tick() }, this.loopSeconds * 1000)
    logger.info('[FastAlgo] Intraminute algo loop started (every %ds)', this.loopSeconds)

    // Kick off immediately instead of waiting the first interval
    void this.tick()
  }

  public stop(): void {
    if (this.samplerTimer) {
      clearInterval(this.samplerTimer)
      this.samplerTimer = null
    }
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }
    this.feed.clearAll()
    logger.info('[FastAlgo] Loop stopped')
  }

  // ── Status (for /api/algo/fast/status) ──────────────────────

  public status(): Record<string, any> {
    const cfg = this.configCache.data
    const subscribed = this.ws.getConnectedSymbols()

    const prices: Record<string, number | null> = {}
    const momentum: Record<string, { momentumPct: number | null; rsi: number | null }> = {}
    const sessions: Record<string, boolean> = {}
    for (const s of subscribed) {
      prices[s] = this.ws.getPrice(s)
      momentum[s] = {
        momentumPct: this.feed.momentumPct(s, cfg?.fastMomentumSeconds ?? 60),
        rsi: this.feed.rsi(s),
      }
      if (this.ws.isSessionOpen) sessions[s] = this.ws.isSessionOpen(s)
    }

    return {
      running: this.running,
      engineRunning: this.engine?.running ?? false,
      loopSeconds: this.loopSeconds,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      active: !!(cfg && cfg.enabled && cfg.fastEnabled && !!this.components?.engine),
      enabled: cfg?.enabled ?? false,
      fastEnabled: cfg?.fastEnabled ?? false,
      broker: cfg?.broker ?? null,
      dryRun: cfg?.dryRun ?? null,
      watchlist: cfg?.fastWatchlist ?? [],
      subscribed,
      prices,
      momentum,
      sessions,
      jev: this.jevStatus(cfg),
      strategy: cfg ? {
        trailingStopPct: cfg.fastTrailingStopPct,
        trailingActivatePct: cfg.fastTrailingActivatePct,
        maxHoldSeconds: cfg.fastMaxHoldSeconds,
        emaPeriod: cfg.fastEmaPeriod,
        volatilityWindowSeconds: cfg.fastVolatilityWindowSeconds,
        volatilityMult: cfg.fastVolatilityMult,
        volatilityFloorPct: cfg.fastVolatilityFloorPct,
        volatilityCeilingPct: cfg.fastVolatilityCeilingPct,
        trendMode: !!cfg.fastTrendMode,
        trendSlopePct: cfg.fastTrendSlopePct,
        trendSlopeWindowSeconds: cfg.fastTrendSlopeWindowSeconds,
        regimeEmaPeriod: cfg.fastRegimeEmaPeriod,
        regimeSlopeWindowSeconds: cfg.fastRegimeSlopeWindowSeconds,
        regimeSlopeMinPct: cfg.fastRegimeSlopeMinPct,
        volumeWindowSeconds: cfg.fastVolumeWindowSeconds,
        volumeMinRatio: cfg.fastVolumeMinRatio,
        correlatedExposurePct: cfg.fastCorrelatedExposurePct,
        riskPerTradePct: cfg.fastRiskPerTradePct,
        maxLossStreak: cfg.fastMaxLossStreak,
        lossStreakPauseSeconds: cfg.fastLossStreakPauseSeconds,
        trailingVolatilityMult: cfg.fastTrailingVolatilityMult,
        scaleOutPct: cfg.fastScaleOutPct,
        makerExecution: !!cfg.fastMakerExecution,
        limitFillSeconds: cfg.fastLimitFillSeconds,
        limitOffsetPct: cfg.fastLimitOffsetPct,
        volTargetPct: cfg.fastVolTargetPct,
        volTargetWindowSeconds: cfg.fastVolTargetWindowSeconds,
        volTargetMaxMult: cfg.fastVolTargetMaxMult,
        slippageBps: cfg.fastSlippageBps,
        harVolForecast: !!cfg.fastHarVolForecast,
        cusumWindowSeconds: cfg.fastCusumWindowSeconds,
        cusumExitPct: cfg.fastCusumExitPct,
        jumpSlackPct: cfg.fastJumpSlackPct,
        choppinessPeriod: cfg.fastChoppinessPeriod,
        choppinessMax: cfg.fastChoppinessMax,
        tradeStartUtc: cfg.fastTradeStartUtc,
        tradeEndUtc: cfg.fastTradeEndUtc,
        convictionSizing: !!cfg.fastConvictionSizing,
        jevGateEnabled: !!cfg.fastJevGateEnabled,
        jevMinConfidence: cfg.fastJevMinConfidence ?? 0.5,
        jevMinEdgePct: cfg.fastJevMinEdgePct ?? 0.15,
        jevTimeoutMs: cfg.fastJevTimeoutMs ?? 2000,
        jevShadowOnly: cfg.fastJevShadowOnly ?? true,
        lossStreak: this.lossStreak,
      } : null,
      cooldowns: [...this.symbolCooldowns.entries()]
        .filter(([, at]) => Date.now() - at < (cfg?.fastCooldownSeconds ?? 180) * 1000)
        .map(([symbol]) => symbol),
    }
  }

  // ── Sampler: 1s tick samples into the momentum feed ─────────

  private sample(): void {
    for (const symbol of this.ws.getConnectedSymbols()) {
      const price = this.ws.getPrice(symbol)
      if (price !== null) this.feed.push(symbol, price)
    }
  }

  // ── Main decision loop ──────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      logger.warn('[FastAlgo] Skipping tick — previous tick still in flight')
      return
    }
    this.tickInFlight = true
    try {
      const cfg = await this.getConfig()
      this.rescheduleIfNeeded(cfg.fastIntervalSeconds)

      if (!cfg.enabled || !cfg.fastEnabled) {
        this.lastTickAt = Date.now()
        return
      }

      await this.resolveComponents(cfg)

      // Feed-only venues (e.g. IBKR before the fast engine ships): prices
      // keep sampling and the status endpoint reports live momentum, but
      // nothing trades until the venue has an execution engine.
      if (!this.components || !this.components.engine) {
        this.syncWatchlist(cfg.fastWatchlist)
        this.lastTickAt = Date.now()
        return
      }

      // Circuit breaker: disable on daily loss breach (same rule as slow loop)
      if (await this.dailyLossBreached(cfg)) return

      // Bring the fast engine up automatically when not running
      if (!this.engine.running) {
        if (!(await this.maybeStartEngine(cfg))) return
      }
      this.syncWatchlist(cfg.fastWatchlist)

      const [openPositions, pendingPositions, closingPositions] = await Promise.all([
        AlgoPosition.query().where('status', 'open'),
        AlgoPosition.query().where('status', 'pending_entry'),
        AlgoPosition.query().where('status', 'closing'),
      ])
      const positionedSymbols = new Set(
        [...openPositions, ...pendingPositions, ...closingPositions].map((p) => p.symbol)
      )

      // Exits first (risk reduction before risk addition)
      for (const pos of openPositions) {
        await this.checkExit(pos, cfg)
      }

      // Reconcile fills against algo positions
      await this.reconcile(cfg)

      // Entries
      await this.checkEntries(cfg, positionedSymbols)

      // Keep the in-memory order map from growing unbounded
      this.engine.pruneCompletedOrders?.()

      this.lastTickAt = Date.now()
      this.lastTickError = null
    } catch (err) {
      this.lastTickError = (err as Error).message
      logger.error('[FastAlgo] Tick failed: %s', this.lastTickError)
    } finally {
      this.tickInFlight = false
    }
  }

  private async getConfig(): Promise<AlgoConfig> {
    if (this.configCache.data && Date.now() - this.configCache.at < CONFIG_CACHE_MS) {
      return this.configCache.data
    }
    const cfg = await AlgoConfig.getConfig()
    this.configCache = { data: cfg, at: Date.now() }
    return cfg
  }

  /**
   * Attach the venue components for cfg.broker. Switching venues mid-run
   * is refused while positions are open (orders belong to one venue — a
   * switch would orphan them). DI-pinned components ('manual') never
   * re-resolve, so unit tests keep their fakes.
   */
  private async resolveComponents(cfg: AlgoConfig): Promise<void> {
    if (this.componentsKey === cfg.broker || this.componentsKey === 'manual') return

    if (this.componentsKey) {
      const open = await AlgoPosition.query().where('status', 'open').first()
      if (open) {
        // Refuse: keep trading on the CURRENT venue so open positions stay
        // managed; log once per attempted destination.
        if (this.refusedSwitch !== cfg.broker) {
          this.refusedSwitch = cfg.broker
          logger.error('[FastAlgo] Cannot switch broker %s → %s while positions are open',
            this.componentsKey, cfg.broker)
        }
        return
      }
    }

    const comp = this.brokerRegistry[cfg.broker]
    if (!comp) {
      logger.error('[FastAlgo] Unknown broker %s — no feed/engine components', cfg.broker)
      this.components = null
      this.componentsKey = cfg.broker
      return
    }
    this.components = { engine: comp.engine, ws: comp.ws, equity: comp.equity }
    this.componentsKey = cfg.broker
    this.engine = comp.engine as any
    this.ws = comp.ws as any
    logger.info('[FastAlgo] Broker components: %s (engine: %s)', cfg.broker, comp.engine ? 'yes' : 'feed-only')
  }

  private rescheduleIfNeeded(seconds: number): void {
    const target = Math.max(MIN_LOOP_SECONDS, seconds || 10)
    if (target === this.loopSeconds || !this.loopTimer) return
    this.loopSeconds = target
    clearInterval(this.loopTimer)
    this.loopTimer = setInterval(() => { void this.tick() }, this.loopSeconds * 1000)
    logger.info('[FastAlgo] Loop rescheduled to %ds', this.loopSeconds)
  }

  private async maybeStartEngine(cfg: AlgoConfig): Promise<boolean> {
    const now = Date.now()
    if (now - this.lastEngineStartAttempt < ENGINE_START_BACKOFF_MS) return false
    this.lastEngineStartAttempt = now

    await this.engine.start(cfg.fastWatchlist)
    if (!this.engine.running) {
      logger.warn('[FastAlgo] Fast engine failed to start (check KRAKEN_API_KEY/SECRET)')
    }
    return this.engine.running
  }

  private syncWatchlist(watchlist: string[]): void {
    for (const symbol of watchlist) {
      if (!this.ws.getConnectedSymbols().includes(symbol)) {
        this.ws.addSymbol(symbol)
      }
      const price = this.ws.getPrice(symbol)
      if (price !== null) this.feed.push(symbol, price)
    }
  }

  /**
   * Overlay introspection for status (U3/U7): mode, model provenance,
   * failure class, and budget — degraded states render explicitly rather
   * than as silent absence. Never throws; a missing introspection method
   * on an injected fake reads as unknown, not as failure.
   */
  private jevStatus(cfg: AlgoConfig | null): Record<string, any> {
    const svc: any = this.jevService
    let budget: any = null
    let failure: any = null
    let provenance: any = null
    let deterministicOnly = false
    try {
      if (svc && typeof svc.getBudgetState === 'function') budget = svc.getBudgetState()
      if (svc && typeof svc.getLastFailure === 'function') failure = svc.getLastFailure()
      if (svc && typeof svc.getProvenance === 'function') provenance = svc.getProvenance()
      if (svc && typeof svc.isDeterministicOnly === 'function') deterministicOnly = !!svc.isDeterministicOnly()
    } catch {
      // Introspection must never break status.
    }
    return {
      enabled: !!cfg?.fastJevGateEnabled,
      shadowOnly: cfg?.fastJevShadowOnly ?? true,
      model: provenance?.model ?? null,
      deterministicOnly,
      lastFailure: failure?.class ?? null,
      budget,
      strategy: cfg
        ? {
            minConfidence: cfg.fastJevMinConfidence ?? 0.5,
            minEdgePct: cfg.fastJevMinEdgePct ?? 0.15,
          }
        : null,
    }
  }

  /**
   * Map the persisted AlgoConfig onto the pure strategy config. A value of
   * 0/null disables the corresponding control (trailing, max-hold, EMA,
   * volatility scaling) — same semantics as the strategy core.
   */
  private toStrategyConfig(cfg: AlgoConfig): FastStrategyConfig {
    return fastStrategyFromConfig(cfg)
  }

  // ── Exits ───────────────────────────────────────────────────

  private async checkExit(pos: AlgoPosition, cfg: AlgoConfig): Promise<void> {
    const price = this.ws.getPrice(pos.symbol)
    if (price === null) return // no live price this tick

    if (pos.forceClose) {
      await this.exitPosition(pos, 'manual force close requested', cfg)
      return
    }

    // Jev exit annotation (advisory only — a slow or failed scorer resolves
    // to null and the deterministic priority chain below runs unchanged).
    // Annotation never influences, so any non-off mode annotates; off (or a
    // latched tripwire) skips the fetch entirely.
    const now = Date.now()
    const jevMode = await this.jevMode(cfg)
    let jevContext: JevContext | null = null
    if (jevMode !== 'off') {
      jevContext = await this.getJevContext(pos.symbol, cfg, now)
    }

    const signal = this.strategy.evaluateExit(
      this.feed,
      pos.symbol,
      price,
      now,
      {
        side: pos.side,
        entryPrice: pos.entryPrice,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        peakPrice: pos.peakPrice,
        openedAt: pos.openedAt.toMillis(),
      },
      this.toStrategyConfig(cfg),
      jevContext
    )

    // Persist trailing state even while holding.
    if (signal.peakPrice !== pos.peakPrice) pos.peakPrice = signal.peakPrice
    if (signal.trailingStop !== null && signal.trailingStop !== pos.stopLoss) {
      pos.stopLoss = signal.trailingStop
      logger.info('[FastAlgo] Trailing stop tightened for %s -> %s',
        pos.symbol, pos.stopLoss.toFixed(2))
    }
    pos.currentPrice = price
    await pos.save()

    // Scale-out: lock in a fraction of the winner when the trail arms.
    if (signal.scaleOut && !pos.scaledOut) {
      await this.scaleOutPosition(pos, price, cfg)
    }

    if (!signal.shouldExit) return
    await this.exitPosition(pos, signal.reason || 'strategy exit', cfg)
  }

  private async scaleOutPosition(pos: AlgoPosition, price: number, cfg: AlgoConfig): Promise<void> {
    const fraction = Math.min(1, Math.max(0, cfg.fastScaleOutPct))
    const qtyOut = Math.floor(pos.quantity * fraction * 1e6) / 1e6
    pos.scaledOut = true

    if (fraction <= 0 || fraction >= 1 || qtyOut <= 0) {
      await pos.save()
      return
    }

    if (cfg.dryRun) {
      await this.logDecision(pos.symbol, pos.tickerId, 'hold', 'scale-out (dry run)', {
        side: 'SELL',
        quantity: qtyOut,
        algoPositionId: pos.id,
        context: { price, exitMode: 'fast', scaleOutPct: fraction, dryRun: true },
      })
    } else {
      const state = await this.engine.placeOrder({
        symbol: pos.symbol,
        side: 'SELL',
        quantity: qtyOut,
        orderType: 'MARKET',
      })
      const tradeId = await this.waitForTradeId(state)
      if (!tradeId) {
        logger.error('[FastAlgo] Scale-out for %s has no trade row, cancelling order %s',
          pos.symbol, state.clientOrderId)
        if (state.externalOrderId) await this.engine.cancelOrder(state.clientOrderId)
        await pos.save()
        return
      }
      await this.logDecision(pos.symbol, pos.tickerId, 'hold', 'scale-out', {
        side: 'SELL',
        quantity: qtyOut,
        tradeId,
        algoPositionId: pos.id,
        context: { price, exitMode: 'fast', scaleOutPct: fraction },
      })
    }

    // Approximate the partial PnL at the decision price (fill-level PnL
    // would need the WS fill data); the remainder rides the trail.
    const direction = pos.side === 'BUY' ? 1 : -1
    const partialPnl = (price - pos.entryPrice) * qtyOut * direction
    pos.quantity -= qtyOut
    pos.scaledOutPnl = (pos.scaledOutPnl || 0) + partialPnl
    logger.info('[FastAlgo] Scale-out %s: sold %s of %s at %s (est. +$%.2f)',
      pos.symbol, qtyOut, pos.quantity, price, partialPnl)
    await pos.save()
  }

  private async exitPosition(pos: AlgoPosition, reason: string, cfg: AlgoConfig): Promise<void> {
    const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY'

    if (cfg.dryRun) {
      await this.logDecision(pos.symbol, pos.tickerId, 'exit', reason, {
        side: exitSide,
        quantity: pos.quantity,
        algoPositionId: pos.id,
        context: {
          entryPrice: pos.entryPrice,
          currentPrice: pos.currentPrice,
          exitMode: 'fast',
        },
      })
      return
    }

    const state = await this.engine.placeOrder({
      symbol: pos.symbol,
      side: exitSide,
      quantity: pos.quantity,
      orderType: 'MARKET',
    })

    const tradeId = await this.waitForTradeId(state)
    if (!tradeId) {
      // Unlinked SELL is an unhedged risk: cancel it immediately.
      logger.error('[FastAlgo] Exit for %s has no trade row, cancelling order %s',
        pos.symbol, state.clientOrderId)
      if (state.externalOrderId) await this.engine.cancelOrder(state.clientOrderId)
      return
    }

    pos.status = 'closing'
    pos.exitTradeId = tradeId
    pos.exitReason = reason
    await pos.save()
    logger.info('[FastAlgo] Exit %s %s: %s (trade=%d)', exitSide, pos.symbol, reason, tradeId)

    await this.logDecision(pos.symbol, pos.tickerId, 'exit', reason, {
      side: exitSide,
      quantity: pos.quantity,
      tradeId,
      algoPositionId: pos.id,
      context: {
        entryPrice: pos.entryPrice,
        currentPrice: pos.currentPrice,
        exitMode: 'fast',
      },
    })
  }

  // ── Entries ─────────────────────────────────────────────────

  private async checkEntries(cfg: AlgoConfig, positionedSymbols: Set<string>): Promise<void> {
    const portfolioValue = await this.getPortfolioValue(cfg)
    if (portfolioValue <= 0) return

    const openPositions = await AlgoPosition.query().where('status', 'open')
    let exposure = 0
    for (const pos of openPositions) {
      exposure += (pos.currentPrice || pos.entryPrice) * pos.quantity
    }
    let exposurePct = portfolioValue > 0 ? exposure / portfolioValue : 0

    // Correlated-basket cap: the watchlist moves together, so cap total
    // exposure across ALL symbols, not just per position.
    const exposureCap = cfg.fastCorrelatedExposurePct > 0
      ? Math.min(cfg.maxExposurePct, cfg.fastCorrelatedExposurePct)
      : cfg.maxExposurePct

    // Loss-streak pause: no entries while the streak persists.
    let streakBlocked = false
    if (cfg.fastMaxLossStreak > 0 && this.lossStreak >= cfg.fastMaxLossStreak) {
      if (cfg.fastLossStreakPauseSeconds <= 0) {
        streakBlocked = true
      } else if (Date.now() - this.streakSinceAt < cfg.fastLossStreakPauseSeconds * 1000) {
        streakBlocked = true
      } else {
        this.lossStreak = 0
      }
    }

    const activeCount = positionedSymbols.size
    const slots = cfg.maxPositions - activeCount
    if (slots <= 0) return
    if (streakBlocked) {
      logger.info('[FastAlgo] Entries paused: %d consecutive losses', this.lossStreak)
      return
    }

    const now = Date.now()
    let used = 0
    // Overlay enforcement resolved once per pass (U6): shadow fetches and
    // records without influencing; off skips the scorer entirely.
    const jevMode = await this.jevMode(cfg)
    const jevEnforcing = jevMode === 'enforce' && !cfg.fastJevShadowOnly

    for (const symbol of cfg.fastWatchlist) {
      if (used >= slots || exposurePct >= exposureCap) break
      if (positionedSymbols.has(symbol)) continue

      const cooldownUntil = this.symbolCooldowns.get(symbol) || 0
      if (now - cooldownUntil < cfg.fastCooldownSeconds * 1000) continue

      const price = this.ws.getPrice(symbol)
      if (price === null) continue

      // Market-session gate: listed instruments only trade during exchange
      // hours (crypto is 24/7; equities have sessions + holidays). Fail-open
      // when the venue can't answer.
      if (this.ws.isSessionOpen && !this.ws.isSessionOpen(symbol)) continue

      // News-sentiment context for the entry gate (null = no signal —
      // the gate never blocks on missing news or infra errors).
      let newsContext: NewsContext | null = null
      if (cfg.fastNewsGateEnabled) {
        newsContext = await this.getNewsContext(symbol, cfg)
      }

      // Jev advisory context (null = no signal — the gate never blocks on
      // a slow, failed, or unkeyed scorer). Shadow mode still fetches
      // (warming the cache, proving the transport) but passes null so the
      // decision is bit-identical to the deterministic baseline.
      let jevContext: JevContext | null = null
      if (jevMode !== 'off') {
        jevContext = await this.getJevContext(symbol, cfg, now)
      }

      const signal = this.strategy.evaluateEntry(
        this.feed, symbol, price, now, this.toStrategyConfig(cfg), newsContext,
        jevEnforcing ? jevContext : null
      )
      if (!signal.shouldEnter) continue

      let sizePct = Math.min(cfg.maxSinglePositionPct, exposureCap - exposurePct)
      if (cfg.fastRiskPerTradePct > 0 && signal.stopLossPct && signal.stopLossPct > 0) {
        sizePct = Math.min(sizePct, cfg.fastRiskPerTradePct / signal.stopLossPct)
      }
      // Volatility targeting (Moreira-Muir): scale exposure so the
      // portfolio's realized vol matches the target.
      if (cfg.fastVolTargetPct > 0 && cfg.fastVolTargetWindowSeconds > 0) {
        const volPct = cfg.fastHarVolForecast
          ? this.feed.harVolatilityPct(symbol, cfg.fastVolTargetWindowSeconds, cfg.fastVolTargetWindowSeconds * 10, cfg.fastVolTargetWindowSeconds * 60, now)
          : this.feed.volatilityPct(symbol, cfg.fastVolTargetWindowSeconds, now)
        const mult = volatilityMultiplier(volPct, cfg.fastVolTargetPct, cfg.fastVolTargetMaxMult || 2)
        // Scale but never exceed the per-position cap.
        sizePct = Math.min(sizePct * mult, cfg.maxSinglePositionPct)
      }
      // Conviction sizing: stronger signal, bigger size (bounded).
      const conviction = this.strategy.convictionMultiplier(signal, this.toStrategyConfig(cfg))
      sizePct = Math.min(sizePct * conviction, cfg.maxSinglePositionPct)
      // Jev shrink-only sizing: calibrated confidence may only reduce
      // exposure within the caps above — never grow it. Anything but an
      // enforced pass scales by 1 (no influence).
      const jevMult = this.strategy.jevConvictionMultiplier(
        jevEnforcing ? jevContext : null, this.toStrategyConfig(cfg)
      )
      sizePct = Math.min(sizePct * jevMult, cfg.maxSinglePositionPct)
      if (sizePct <= 0) break

      const rawQty = (portfolioValue * sizePct) / price
      const quantity = Math.floor(rawQty * 1e6) / 1e6
      if (quantity <= 0) continue

      const stopLoss = signal.stopLoss ?? price * (1 - cfg.fastStopLossPct / 100)
      const takeProfit = signal.takeProfit ?? price * (1 + cfg.fastTakeProfitPct / 100)
      const reason = `momentum entry: ${signal.reason}`
      this.symbolCooldowns.set(symbol, now)
      used++
      exposurePct += sizePct

      if (cfg.dryRun) {
        await this.logDecision(symbol, 0, 'enter', reason, {
          side: 'BUY',
          quantity,
          compositeScore: signal.momentumPct ?? null,
          conviction: 0.5,
          regime: 'momentum',
          positionSizePct: sizePct,
          stopLoss,
          takeProfit,
          context: { price, rsi: signal.rsi, ema: signal.ema, volatilityPct: signal.volatilityPct, exitMode: 'fast', dryRun: true, makerExecution: !!cfg.fastMakerExecution },
        })
        continue
      }

      // Maker execution: post a limit, wait for the fill window, cancel and
      // retry once at a fresh price. Miss = no position (acceptable for
      // entries; exits stay MARKET for reliability).
      let fillPrice = price
      let entryState: any = null
      if (cfg.fastMakerExecution) {
        let limitPrice = price * (1 + (cfg.fastLimitOffsetPct || 0) / 100)
        let filled = false
        for (let attempt = 0; attempt <= 1; attempt++) {
          entryState = await this.engine.placeOrder({
            symbol,
            side: 'BUY',
            quantity,
            orderType: 'LIMIT',
            price: limitPrice,
            timeInForce: 'GTC',
          })
          const fill = await this.waitForFill(entryState, cfg.fastLimitFillSeconds * 1000)
          if (fill !== null) {
            filled = true
            fillPrice = fill
            break
          }
          await this.engine.cancelOrder(entryState.clientOrderId)
          const fresh = this.ws.getPrice(symbol)
          if (fresh === null) break
          limitPrice = fresh * (1 + (cfg.fastLimitOffsetPct || 0) / 100)
        }
        if (!filled) {
          await this.logDecision(symbol, 0, 'skip', 'limit entry unfilled', {
            side: 'BUY',
            quantity,
            positionSizePct: sizePct,
            context: { price, limitPrice, exitMode: 'fast', makerExecution: true },
          })
          continue
        }
      } else {
        entryState = await this.engine.placeOrder({
          symbol,
          side: 'BUY',
          quantity,
          orderType: 'MARKET',
        })
      }

      const tradeId = await this.waitForTradeId(entryState)
      if (!tradeId) {
        logger.error('[FastAlgo] Entry for %s has no trade row, cancelling order %s',
          symbol, entryState.clientOrderId)
        if (entryState.externalOrderId) await this.engine.cancelOrder(entryState.clientOrderId)
        continue
      }
      if (!entryState.tickerId) continue

      // SL/TP scale with the actual fill price (limit != decision price).
      const fillRatio = fillPrice / price
      const algoPos = await AlgoPosition.create({
        tickerId: entryState.tickerId,
        symbol,
        side: 'BUY',
        quantity,
        entryPrice: fillPrice,
        currentPrice: fillPrice,
        peakPrice: fillPrice,
        decisionPrice: price,
        stopLoss: stopLoss * fillRatio,
        takeProfit: takeProfit * fillRatio,
        entryScore: signal.momentumPct ?? 0,
        entryConviction: 0.5,
        entryRegime: 'momentum',
        entryReason: reason,
        entryTradeId: tradeId,
        status: 'pending_entry',
        forceClose: false,
        scaledOut: false,
        openedAt: DateTime.now(),
      })
      logger.info('[FastAlgo] Entry BUY %s qty=%s trade=%d position=%d%s',
        symbol, quantity, tradeId, algoPos.id,
        fillPrice !== price ? ` fill=${fillPrice} decision=${price}` : '')

      await this.logDecision(symbol, entryState.tickerId, 'enter', reason, {
        side: 'BUY',
        quantity,
        compositeScore: signal.momentumPct ?? null,
        conviction: 0.5,
        regime: 'momentum',
        positionSizePct: sizePct,
        stopLoss: stopLoss * fillRatio,
        takeProfit: takeProfit * fillRatio,
        tradeId,
        algoPositionId: algoPos.id,
        context: { price, fillPrice, rsi: signal.rsi, ema: signal.ema, volatilityPct: signal.volatilityPct, exitMode: 'fast' },
      })
    }
  }

  // ── Position reconciliation ─────────────────────────────────

  private async reconcile(cfg: AlgoConfig): Promise<void> {
    const [pendingPositions, openPositions, closingPositions] = await Promise.all([
      AlgoPosition.query().where('status', 'pending_entry').preload('entryTrade'),
      AlgoPosition.query().where('status', 'open').preload('entryTrade'),
      AlgoPosition.query().where('status', 'closing').preload('exitTrade'),
    ])

    for (const pos of pendingPositions) {
      const trade = pos.entryTrade
      if (!trade) continue

      if (trade.status === 'filled') {
        pos.status = 'open'
        if (trade.fillPrice) {
          pos.entryPrice = trade.fillPrice
          pos.currentPrice = trade.fillPrice
        }
        await pos.save()
        logger.info('[FastAlgo] Entry filled for %s @ %s', pos.symbol, pos.entryPrice)
      } else if (TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        pos.status = 'closed'
        pos.exitReason = `entry trade ${trade.status}: ${trade.errorMessage || trade.status}`
        pos.closedAt = DateTime.now()
        pos.realizedPnl = 0
        await pos.save()
      }
    }

    for (const pos of openPositions) {
      const trade = pos.entryTrade
      if (!trade || trade.status !== 'filled' || !trade.fillPrice) continue
      if (pos.entryPrice !== trade.fillPrice) {
        pos.entryPrice = trade.fillPrice
        await pos.save()
      }
    }

    for (const pos of closingPositions) {
      const trade = pos.exitTrade
      if (!trade) continue

      if (trade.status === 'filled') {
        const exitPrice = trade.fillPrice || pos.currentPrice || pos.entryPrice
        const direction = pos.side === 'BUY' ? 1 : -1
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * direction
        pos.status = 'closed'
        pos.exitPrice = exitPrice
        pos.realizedPnl = pnl
        pos.closedAt = DateTime.now()
        await pos.save()
        logger.info('[FastAlgo] Position closed: %s P&L $%.2f', pos.symbol, pnl)

        // Loss-streak accounting for the entry pause.
        if (pnl > 0) {
          this.lossStreak = 0
        } else {
          this.lossStreak++
          if (cfg.fastMaxLossStreak > 0 && this.lossStreak >= cfg.fastMaxLossStreak) {
            this.streakSinceAt = Date.now()
          }
        }
      } else if (TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        pos.status = 'open'
        pos.exitTradeId = null
        pos.exitReason = null
        await pos.save()
        logger.warn('[FastAlgo] Exit trade failed for %s, resetting to open', pos.symbol)
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async waitForTradeId(state: any, timeoutMs = 3000): Promise<number | null> {
    if (state.tradeId) return state.tradeId
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (state.tradeId) return state.tradeId
      if (state.status === 'error') return null
    }
    return state.tradeId ?? null
  }

  /**
   * Wait for a limit fill: returns the fill price once the engine reports
   * filled/partially_filled, or null on timeout/error.
   */
  private async waitForFill(state: any, timeoutMs = 15000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (['filled', 'partially_filled'].includes(state.status)) {
        return state.fillPrice ?? null
      }
      if (state.status === 'cancelled' || state.status === 'error') return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  }

  private async getNewsContext(symbol: string, cfg: AlgoConfig): Promise<NewsContext | null> {
    const tickerId = await this.tickerIdFor(symbol)
    if (!tickerId) return null
    const result = await this.newsService.getSymbolSentiment(tickerId, cfg.fastNewsWindowHours)
    return result ? { score: result.score, events: result.events } : null
  }

  /**
   * Jev advisory context for one symbol (U3): indicator facts from the feed
   * plus recent headlines, fetched inside an absolute deadline so a slow or
   * hanging scorer can never stall the tick. Null on any failure — the
   * deterministic path runs exactly as before.
   */
  /**
   * Overlay enforcement mode (U6): off skips the scorer entirely (no
   * spend); shadow fetches and records without influencing; enforce lets
   * the context into the gate and sizing. A latched tripwire forces off.
   * Live stage without a fresh preflight degrades to shadow — enforcement
   * without proof is refused, not retried into.
   */
  private async jevMode(cfg: AlgoConfig): Promise<'off' | 'shadow' | 'enforce'> {
    if (!cfg.fastJevGateEnabled) return 'off'
    try {
      const [stage, latched] = await Promise.all([
        this.jevRollout.getStage(),
        this.jevRollout.isLatched(),
      ])
      if (latched) return 'off'
      if (stage === 'shadow') return 'shadow'
      if (stage === 'live') {
        const ready =
          this.jevService && typeof this.jevService.isLiveReady === 'function'
            ? !!this.jevService.isLiveReady()
            : false
        if (!ready) return 'shadow'
      }
      return 'enforce'
    } catch {
      return 'off'
    }
  }

  private async getJevContext(symbol: string, cfg: AlgoConfig, now: number): Promise<JevContext | null> {
    try {
      const tickerId = await this.tickerIdFor(symbol)
      const headlines = await this.getJevHeadlines(tickerId)
      const timeoutMs = cfg.fastJevTimeoutMs && cfg.fastJevTimeoutMs > 0 ? cfg.fastJevTimeoutMs : 2000
      const started = Date.now()
      const ctx = await this.withTimeout(
        this.jevService.getDecision({
          symbol,
          facts: {
            momentumPct: this.feed.momentumPct(symbol, cfg.fastMomentumSeconds),
            rsi: this.feed.rsi(symbol),
            emaSlopePct: null,
            volatilityPct: null,
            priceChangePct: null,
          },
          headlines,
          asOf: now,
        }),
        timeoutMs
      )
      if (!ctx) return null
      // Record every enforced live score for honest replay (U4). Fixture
      // contexts never certify — they are skipped. Best effort: a failed
      // insert must never break the tick.
      if (!ctx.fixture) {
        void this.recordJevScore(symbol, ctx, now, Date.now() - started).catch(() => {})
      }
      return {
        pUp: ctx.pUp ?? null,
        pDown: ctx.pDown ?? null,
        confidence: ctx.confidence ?? null,
        stale: !!ctx.stale,
      }
    } catch {
      return null
    }
  }

  /**
   * Append one score row with its full attribution tuple. Fire-and-forget
   * from the tick path — callers must not await it past the tick deadline.
   */
  public async recordJevScore(
    symbol: string,
    ctx: { pUp: number | null; pDown: number | null; confidence: number | null; model: string; usage?: { inputTokens: number; outputTokens: number }; stale?: boolean },
    now: number,
    latencyMs: number
  ): Promise<void> {
    let questionHash = 'unknown'
    try {
      if (this.jevService && typeof this.jevService.getQuestionHash === 'function') {
        questionHash = this.jevService.getQuestionHash()
      }
    } catch {
      questionHash = 'unknown'
    }
    await db.table('ml_scores').insert({
      symbol,
      decided_at: now,
      model: ctx.model,
      question_hash: questionHash,
      prompt_version: 'v1',
      window_seconds: 0,
      p_up: ctx.pUp,
      p_down: ctx.pDown,
      confidence: ctx.confidence,
      latency_ms: Math.max(0, Math.round(latencyMs)),
      stale: !!ctx.stale,
      fixture: false,
    })
  }

  /** Recent headlines for Jev state — best effort, empty on any failure. */
  private async getJevHeadlines(tickerId: number | null): Promise<string[]> {
    if (!tickerId) return []
    try {
      const since = new Date(Date.now() - 3600_000).toISOString()
      const analyses = await this.meili.getAnalysesForTicker(tickerId, since)
      if (!Array.isArray(analyses)) return []
      const titles: string[] = []
      for (const analysis of analyses) {
        const title = (analysis as any)?.title
        if (typeof title === 'string' && title.trim()) titles.push(title)
        if (titles.length >= 10) break
      }
      return titles
    } catch {
      return []
    }
  }

  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        work,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async tickerIdFor(symbol: string): Promise<number | null> {
    if (Date.now() - this.tickerIdCache.at > 60_000) {
      const tickers = await this.tickerModel.query().where('is_active', true)
      this.tickerIdCache = {
        map: new Map(tickers.map((t: any) => [t.symbol, t.id])),
        at: Date.now(),
      }
    }
    return this.tickerIdCache.map.get(symbol) ?? null
  }

  private async getPortfolioValue(cfg: AlgoConfig): Promise<number> {
    const now = Date.now()
    if (this.portfolioCache.value > 0 && now - this.portfolioCache.at < PORTFOLIO_CACHE_MS) {
      return this.portfolioCache.value
    }
    try {
      const equity = this.components?.equity ?? KrakenService
      const value = await equity.getEquity()
      this.portfolioCache = { value, at: now }
      return value
    } catch (err) {
      logger.error('[FastAlgo] Failed to get portfolio value: %s', (err as Error).message)
      return 0
    }
  }

  private async dailyLossBreached(cfg: AlgoConfig): Promise<boolean> {
    const today = DateTime.now().startOf('day')
    const result = await db.rawQuery(
      'SELECT COALESCE(SUM(realized_pnl), 0) as total FROM algo_positions WHERE status = ? AND closed_at >= ?',
      ['closed', today.toSQL()]
    )
    const dailyPnl = Number(result[0]?.[0]?.total || result[0]?.total || 0)
    const portfolioValue = await this.getPortfolioValue(cfg)
    if (portfolioValue <= 0) return false
    const dailyLossPct = dailyPnl / portfolioValue

    if (dailyLossPct < -cfg.dailyLossLimitPct) {
      const reason = `circuit_breaker: daily loss ${(dailyLossPct * 100).toFixed(2)}% exceeded limit ${(cfg.dailyLossLimitPct * 100).toFixed(1)}%`
      logger.warn('[FastAlgo] %s', reason)
      cfg.enabled = false
      cfg.disabledReason = reason
      await cfg.save()
      NotificationService.emit({
        type: 'algo_update',
        event: 'circuit_breaker',
        message: reason,
        timestamp: new Date().toISOString(),
      } as any)
      return true
    }
    return false
  }

  private async logDecision(
    symbol: string,
    tickerId: number,
    decision: 'enter' | 'exit' | 'hold' | 'skip',
    reason: string,
    extras: {
      side?: string | null
      quantity?: number | null
      compositeScore?: number | null
      conviction?: number | null
      regime?: string | null
      positionSizePct?: number | null
      stopLoss?: number | null
      takeProfit?: number | null
      tradeId?: number | null
      algoPositionId?: number | null
      context?: Record<string, any>
    } = {}
  ): Promise<void> {
    try {
      await MeilisearchService.saveDecision({
        runId: this.runId,
        symbol,
        tickerId,
        decision,
        reason: reason.slice(0, 500),
        side: (extras.side as any) || null,
        quantity: extras.quantity ?? null,
        compositeScore: extras.compositeScore ?? null,
        conviction: extras.conviction ?? null,
        regime: extras.regime ?? null,
        positionSizePct: extras.positionSizePct ?? null,
        stopLoss: extras.stopLoss ?? null,
        takeProfit: extras.takeProfit ?? null,
        tradeId: extras.tradeId ?? null,
        algoPositionId: extras.algoPositionId ?? null,
        context: extras.context ?? null,
      })
    } catch (err) {
      logger.error('[FastAlgo] Failed to log decision for %s: %s', symbol, (err as Error).message)
    }
  }
}

export default new FastAlgoService()
