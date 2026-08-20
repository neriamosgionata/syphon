import { v4 as uuidv4 } from 'uuid'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import AlgoConfig from '#models/AlgoConfig'
import AlgoPosition from '#models/AlgoPosition'
import KrakenFastEngine from '#services/KrakenFastEngine'
import KrakenService from '#services/KrakenService'
import KrakenWS from '#services/KrakenWebSocketService'
import { MomentumFeed } from '#services/MomentumFeed'
import { FastStrategy, FastStrategyConfig, fastStrategyFromConfig } from '#services/FastStrategy'
import MeilisearchService from '#services/MeilisearchService'
import NotificationService from '#services/NotificationService'

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

  private configCache: { data: AlgoConfig | null; at: number } = { data: null, at: 0 }
  private portfolioCache: { value: number; at: number } = { value: 0, at: 0 }
  private symbolCooldowns = new Map<string, number>()
  private runId = uuidv4()

  constructor(opts: { engine?: any; ws?: any; feed?: MomentumFeed; strategy?: FastStrategy } = {}) {
    this.engine = opts.engine ?? KrakenFastEngine
    this.ws = opts.ws ?? KrakenWS
    this.feed = opts.feed ?? new MomentumFeed()
    this.strategy = opts.strategy ?? new FastStrategy()
  }

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
      const pnl = Number(pos.realizedPnl) || 0
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

      const returnPct = pos.entryPrice > 0
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
    for (const s of subscribed) {
      prices[s] = this.ws.getPrice(s)
      momentum[s] = {
        momentumPct: this.feed.momentumPct(s, cfg?.fastMomentumSeconds ?? 60),
        rsi: this.feed.rsi(s),
      }
    }

    return {
      running: this.running,
      engineRunning: this.engine.running,
      loopSeconds: this.loopSeconds,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      active: !!(cfg && cfg.enabled && cfg.fastEnabled && cfg.broker === 'kraken'),
      enabled: cfg?.enabled ?? false,
      fastEnabled: cfg?.fastEnabled ?? false,
      broker: cfg?.broker ?? null,
      dryRun: cfg?.dryRun ?? null,
      watchlist: cfg?.fastWatchlist ?? [],
      subscribed,
      prices,
      momentum,
      strategy: cfg ? {
        trailingStopPct: cfg.fastTrailingStopPct,
        trailingActivatePct: cfg.fastTrailingActivatePct,
        maxHoldSeconds: cfg.fastMaxHoldSeconds,
        emaPeriod: cfg.fastEmaPeriod,
        volatilityWindowSeconds: cfg.fastVolatilityWindowSeconds,
        volatilityMult: cfg.fastVolatilityMult,
        volatilityFloorPct: cfg.fastVolatilityFloorPct,
        volatilityCeilingPct: cfg.fastVolatilityCeilingPct,
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
    try {
      const cfg = await this.getConfig()
      this.rescheduleIfNeeded(cfg.fastIntervalSeconds)

      if (!cfg.enabled || !cfg.fastEnabled || cfg.broker !== 'kraken') {
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
      await this.reconcile()

      // Entries
      await this.checkEntries(cfg, positionedSymbols)

      // Keep the in-memory order map from growing unbounded
      this.engine.pruneCompletedOrders?.()

      this.lastTickAt = Date.now()
      this.lastTickError = null
    } catch (err) {
      this.lastTickError = (err as Error).message
      logger.error('[FastAlgo] Tick failed: %s', this.lastTickError)
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

    const signal = this.strategy.evaluateExit(
      this.feed,
      pos.symbol,
      price,
      Date.now(),
      {
        side: pos.side,
        entryPrice: pos.entryPrice,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        peakPrice: pos.peakPrice,
        openedAt: pos.openedAt.toMillis(),
      },
      this.toStrategyConfig(cfg)
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

    if (!signal.shouldExit) return
    await this.exitPosition(pos, signal.reason || 'strategy exit', cfg)
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

    const activeCount = positionedSymbols.size
    const slots = cfg.maxPositions - activeCount
    if (slots <= 0) return

    const now = Date.now()
    let used = 0

    for (const symbol of cfg.fastWatchlist) {
      if (used >= slots || exposurePct >= cfg.maxExposurePct) break
      if (positionedSymbols.has(symbol)) continue

      const cooldownUntil = this.symbolCooldowns.get(symbol) || 0
      if (now - cooldownUntil < cfg.fastCooldownSeconds * 1000) continue

      const price = this.ws.getPrice(symbol)
      if (price === null) continue

      const signal = this.strategy.evaluateEntry(
        this.feed, symbol, price, now, this.toStrategyConfig(cfg)
      )
      if (!signal.shouldEnter) continue

      const sizePct = Math.min(cfg.maxSinglePositionPct, cfg.maxExposurePct - exposurePct)
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
          context: { price, rsi: signal.rsi, ema: signal.ema, volatilityPct: signal.volatilityPct, exitMode: 'fast', dryRun: true },
        })
        continue
      }

      const state = await this.engine.placeOrder({
        symbol,
        side: 'BUY',
        quantity,
        orderType: 'MARKET',
      })

      const tradeId = await this.waitForTradeId(state)
      if (!tradeId) {
        logger.error('[FastAlgo] Entry for %s has no trade row, cancelling order %s',
          symbol, state.clientOrderId)
        if (state.externalOrderId) await this.engine.cancelOrder(state.clientOrderId)
        continue
      }
      if (!state.tickerId) continue

      const algoPos = await AlgoPosition.create({
        tickerId: state.tickerId,
        symbol,
        side: 'BUY',
        quantity,
        entryPrice: price,
        currentPrice: price,
        peakPrice: price,
        stopLoss,
        takeProfit,
        entryScore: signal.momentumPct ?? 0,
        entryConviction: 0.5,
        entryRegime: 'momentum',
        entryReason: reason,
        entryTradeId: tradeId,
        status: 'pending_entry',
        forceClose: false,
        openedAt: DateTime.now(),
      })
      logger.info('[FastAlgo] Entry BUY %s qty=%s trade=%d position=%d', symbol, quantity, tradeId, algoPos.id)

      await this.logDecision(symbol, state.tickerId, 'enter', reason, {
        side: 'BUY',
        quantity,
        compositeScore: signal.momentumPct ?? null,
        conviction: 0.5,
        regime: 'momentum',
        positionSizePct: sizePct,
        stopLoss,
        takeProfit,
        tradeId,
        algoPositionId: algoPos.id,
        context: { price, rsi: signal.rsi, ema: signal.ema, volatilityPct: signal.volatilityPct, exitMode: 'fast' },
      })
    }
  }

  // ── Position reconciliation ─────────────────────────────────

  private async reconcile(): Promise<void> {
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

  private async getPortfolioValue(cfg: AlgoConfig): Promise<number> {
    const now = Date.now()
    if (this.portfolioCache.value > 0 && now - this.portfolioCache.at < PORTFOLIO_CACHE_MS) {
      return this.portfolioCache.value
    }
    try {
      if (!KrakenService.isConnected) await KrakenService.connect()
      const tb = await KrakenService.getTradeBalance()
      const value = parseFloat(tb.eb || '0')
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
