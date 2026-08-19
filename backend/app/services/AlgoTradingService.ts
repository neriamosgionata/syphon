import { v4 as uuidv4 } from 'uuid'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import QuantEngine, { ScreenerResult } from '#services/QuantEngine'
import IBKRService from '#services/IBKRService'
import KrakenService from '#services/KrakenService'
import BinanceService from '#services/BinanceService'
import QueueService, { QUEUE_NAMES } from '#jobs/QueueService'
import NotificationService from '#services/NotificationService'
import MeilisearchService from '#services/MeilisearchService'
import AlgoConfig from '#models/AlgoConfig'
import AlgoPosition from '#models/AlgoPosition'
import Trade from '#models/Trade'
import type { TradeStatus } from '#models/Trade'
import Ticker from '#models/Ticker'

// ─── Types ──────────────────────────────────────────────────

type ProgressCallback = (pct: number, stage: string, detail?: string) => Promise<void>

interface RunResult {
  runId: string
  dryRun: boolean
  portfolioValue: number
  positionsBefore: number
  decisionsEnter: number
  decisionsExit: number
  decisionsHold: number
  decisionsSkip: number
  errors: string[]
  durationMs: number
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

type ScreenerTicker = ScreenerResult['tickers'][number]

interface NNPrediction {
  pair: string
  direction: 'down' | 'flat' | 'up'
  direction_probs: { down: number; flat: number; up: number }
  returns: { r30m: number; r1h: number; r3h: number }
  confidence: number
  timestamp: string
}

// ─── Service ────────────────────────────────────────────────

const TERMINAL_TRADE_STATUSES = ['filled', 'cancelled', 'error', 'inactive']
const STUCK_TRADE_RECOVERY_MINUTES = 60

export default class AlgoTradingService {
  private runId: string
  private config!: AlgoConfig
  private progress: ProgressCallback
  private nnPredictions = new Map<string, NNPrediction>()

  constructor() {
    this.runId = uuidv4()
    this.progress = async () => {}
  }

  // ── Main entry point ────────────────────────────────────────

  public async run(progressCallback?: ProgressCallback): Promise<RunResult> {
    if (progressCallback) this.progress = progressCallback
    const start = Date.now()
    const result: RunResult = {
      runId: this.runId,
      dryRun: true,
      portfolioValue: 0,
      positionsBefore: 0,
      decisionsEnter: 0,
      decisionsExit: 0,
      decisionsHold: 0,
      decisionsSkip: 0,
      errors: [],
      durationMs: 0,
    }

    try {
      // Step 1: Load config and gate checks
      await this.progress(5, 'Loading configuration')
      this.config = await AlgoConfig.getConfig()
      result.dryRun = this.config.dryRun

      if (!this.config.enabled) {
        result.durationMs = Date.now() - start
        return result
      }

      // Cooldown check
      if (this.config.lastRunAt) {
        const minsSinceLastRun = DateTime.now().diff(this.config.lastRunAt, 'minutes').minutes
        if (minsSinceLastRun < this.config.cooldownMinutes) {
          logger.info('[Algo] Cooldown: %.1f min since last run (min %d)', minsSinceLastRun, this.config.cooldownMinutes)
          result.durationMs = Date.now() - start
          return result
        }
      }

      // Step 2: Broker connection + portfolio value
      await this.progress(10, 'Checking broker connection')
      const portfolioValue = await this.getPortfolioValue()
      if (portfolioValue <= 0) {
        result.errors.push('Cannot determine portfolio value - is broker connected?')
        result.durationMs = Date.now() - start
        return result
      }
      result.portfolioValue = portfolioValue

      // Circuit breaker: daily loss check
      const dailyPnl = await this.getDailyRealizedPnl()
      const dailyLossPct = dailyPnl / portfolioValue
      if (dailyLossPct < -this.config.dailyLossLimitPct) {
        logger.warn('[Algo] CIRCUIT BREAKER: daily loss %.2f%% exceeds limit %.2f%%',
          dailyLossPct * 100, this.config.dailyLossLimitPct * 100)
        this.config.enabled = false
        this.config.disabledReason = `circuit_breaker: daily loss ${(dailyLossPct * 100).toFixed(2)}% exceeded limit ${(this.config.dailyLossLimitPct * 100).toFixed(1)}%`
        await this.config.save()
        NotificationService.emit({
          type: 'algo_update',
          event: 'circuit_breaker',
          message: this.config.disabledReason,
          timestamp: new Date().toISOString(),
        } as any)
        result.errors.push(this.config.disabledReason)
        result.durationMs = Date.now() - start
        return result
      }

      // Step 3: Get current state
      await this.progress(15, 'Loading portfolio state')
      const [openPositions, closingPositions, pendingPositions] = await Promise.all([
        AlgoPosition.query().where('status', 'open'),
        AlgoPosition.query().where('status', 'closing'),
        AlgoPosition.query().where('status', 'pending_entry'),
      ])
      result.positionsBefore = openPositions.length

      // Step 4: Run screener
      await this.progress(25, 'Running QuantEngine screener')
      // QuantEngine is an exported singleton instance — constructing it would
      // throw "not a constructor" and abort every algo run.
      const engine = QuantEngine
      const screenerResult = await engine.screener({ days: 365, minArticles: 0 })

      const screenerMap = new Map<string, ScreenerTicker>()
      for (const t of screenerResult.tickers) {
        screenerMap.set(t.symbol, t)
      }

      // Step 5: Process exits first (risk reduction before risk addition)
      await this.progress(50, 'Processing exits')
      for (const pos of openPositions) {
        try {
          const exitResult = await this.evaluateExit(pos, screenerMap, engine, portfolioValue)
          if (exitResult.decision === 'exit') {
            result.decisionsExit++
          } else {
            result.decisionsHold++
          }
        } catch (err) {
          const msg = `Exit evaluation error for ${pos.symbol}: ${(err as Error).message}`
          logger.error('[Algo] %s', msg)
          result.errors.push(msg)
        }
      }

      // Also check closing positions for stuck exits
      for (const pos of closingPositions) {
        const screenerData = screenerMap.get(pos.symbol)
        if (screenerData?.price) {
          pos.currentPrice = screenerData.price
          await pos.save()
        }
      }

      // Step 5b: Fetch NN predictions for crypto symbols
      await this.progress(60, 'Fetching NN predictions')
      const allSymbols = screenerResult.tickers.map((t) => t.symbol)
      await this.fetchNNPredictions(allSymbols)

      // Step 6: Process entries
      await this.progress(70, 'Evaluating entry candidates')
      const currentOpenCount = await AlgoPosition.query()
        .whereIn('status', ['open', 'closing', 'pending_entry'])
        .count('* as total')
      const activePositionCount = Number(currentOpenCount[0].$extras.total)

      // Symbols already in position or pending
      const positionedSymbols = new Set<string>()
      for (const pos of [...openPositions, ...closingPositions, ...pendingPositions]) {
        positionedSymbols.add(pos.symbol)
      }

      // Filter and rank entry candidates
      const candidates = screenerResult.tickers
        .filter((t) => {
          if (!t.price || t.price <= 0) return false
          if (t.composite_score < this.config.entryScoreThreshold) return false
          if (t.conviction < this.config.minConviction) return false
          if (t.article_count < this.config.minArticles) return false
          if (!this.config.allowedRegimes.includes(t.regime)) return false
          if (this.config.excludedSymbols.includes(t.symbol)) return false
          if (positionedSymbols.has(t.symbol)) return false
          if (!['buy', 'strong_buy'].includes(t.signal)) return false
          return true
        })
        .sort((a, b) => Math.abs(b.composite_score) * b.conviction - Math.abs(a.composite_score) * a.conviction)

      // Calculate current exposure
      let currentExposure = 0
      for (const pos of openPositions) {
        const price = pos.currentPrice || pos.entryPrice
        currentExposure += price * pos.quantity
      }
      let currentExposurePct = portfolioValue > 0 ? currentExposure / portfolioValue : 0

      let slotsAvailable = this.config.maxPositions - activePositionCount

      for (const candidate of candidates) {
        if (slotsAvailable <= 0) break
        if (currentExposurePct >= this.config.maxExposurePct) break

        try {
          const entered = await this.evaluateEntry(candidate, engine, portfolioValue, currentExposurePct)
          if (entered) {
            result.decisionsEnter++
            slotsAvailable--
            currentExposurePct += entered.exposurePct
          } else {
            result.decisionsSkip++
          }
        } catch (err) {
          const msg = `Entry evaluation error for ${candidate.symbol}: ${(err as Error).message}`
          logger.error('[Algo] %s', msg)
          result.errors.push(msg)
        }
      }

      // Log skips for notable non-qualifying tickers (|score| >= 15 but didn't pass filters)
      await this.progress(85, 'Logging decisions')
      for (const t of screenerResult.tickers) {
        if (Math.abs(t.composite_score) < 15) continue
        if (candidates.some((c) => c.symbol === t.symbol)) continue
        if (positionedSymbols.has(t.symbol)) continue

        const skipReason = this.getSkipReason(t, positionedSymbols)
        if (skipReason) {
          await this.logDecision(t.symbol, await this.getTickerId(t.symbol), 'skip', skipReason, {
            compositeScore: t.composite_score,
            conviction: t.conviction,
            regime: t.regime,
          })
          result.decisionsSkip++
        }
      }

      // Step 7: Update config
      await this.progress(95, 'Finalizing')
      this.config.lastRunAt = DateTime.now()
      await this.config.save()

    } catch (err) {
      logger.error('[Algo] Run failed: %s', (err as Error).message)
      result.errors.push(`Fatal: ${(err as Error).message}`)
    }

    result.durationMs = Date.now() - start
    logger.info(
      '[Algo] Run %s: %d entries, %d exits, %d holds, %d skips (dryRun=%s, %dms)',
      this.runId, result.decisionsEnter, result.decisionsExit,
      result.decisionsHold, result.decisionsSkip, result.dryRun, result.durationMs
    )

    return result
  }

  // ── Exit evaluation ─────────────────────────────────────────

  private async evaluateExit(
    pos: AlgoPosition,
    screenerMap: Map<string, ScreenerTicker>,
    _engine: typeof QuantEngine,
    _portfolioValue: number
  ): Promise<{ decision: 'exit' | 'hold' }> {
    const screenerData = screenerMap.get(pos.symbol)
    const currentPrice = screenerData?.price || pos.currentPrice || pos.entryPrice

    // Update current price on the position
    pos.currentPrice = currentPrice
    await pos.save()

    const isBuy = pos.side === 'BUY'
    let exitReason: string | null = null

    // Priority 1: Force close
    if (pos.forceClose) {
      exitReason = 'manual force close requested'
    }

    // Priority 2: Stop-loss
    if (!exitReason) {
      if (isBuy && currentPrice <= pos.stopLoss) {
        exitReason = `stop-loss triggered: price ${currentPrice} <= SL ${pos.stopLoss}`
      } else if (!isBuy && currentPrice >= pos.stopLoss) {
        exitReason = `stop-loss triggered: price ${currentPrice} >= SL ${pos.stopLoss}`
      }
    }

    // Priority 3: Take-profit
    if (!exitReason) {
      if (isBuy && currentPrice >= pos.takeProfit) {
        exitReason = `take-profit triggered: price ${currentPrice} >= TP ${pos.takeProfit}`
      } else if (!isBuy && currentPrice <= pos.takeProfit) {
        exitReason = `take-profit triggered: price ${currentPrice} <= TP ${pos.takeProfit}`
      }
    }

    // Priority 4: Signal reversal
    if (!exitReason && screenerData) {
      if (isBuy && screenerData.composite_score < this.config.exitScoreThreshold) {
        exitReason = `signal reversal: score ${screenerData.composite_score} < threshold ${this.config.exitScoreThreshold}`
      }
    }

    // Priority 5: Max holding period
    if (!exitReason) {
      const daysHeld = Math.floor(DateTime.now().diff(pos.openedAt, 'days').days)
      if (daysHeld >= this.config.maxHoldingDays) {
        exitReason = `max holding period: ${daysHeld} days >= limit ${this.config.maxHoldingDays}`
      }
    }

    if (exitReason) {
      // Execute exit
      const exitSide = isBuy ? 'SELL' : 'BUY'
      let tradeId: number | null = null

      if (!this.config.dryRun) {
        const ticker = await Ticker.query().where('symbol', pos.symbol).first()
        if (ticker) {
          const trade = await Trade.create({
            tickerId: ticker.id,
            symbol: pos.symbol,
            side: exitSide as any,
            orderType: this.config.orderType as any,
            quantity: pos.quantity,
            broker: this.config.broker as any,
            status: 'pending',
            exchange: this.config.broker === 'kraken' || this.config.broker === 'binance' ? 'spot' : 'SMART',
            currency: 'USD',
            filledQuantity: 0,
            timeInForce: this.config.timeInForce,
          })
          tradeId = trade.id
          await QueueService.addJob(QUEUE_NAMES.SUBMIT_ORDER, { tradeId: trade.id })

          pos.status = 'closing'
          pos.exitTradeId = trade.id
          pos.exitReason = exitReason
          await pos.save()
        }
      }

      await this.logDecision(pos.symbol, pos.tickerId, 'exit', exitReason, {
        side: exitSide,
        quantity: pos.quantity,
        compositeScore: screenerData?.composite_score ?? null,
        conviction: screenerData?.conviction ?? null,
        regime: screenerData?.regime ?? null,
        tradeId,
        algoPositionId: pos.id,
        context: {
          entryPrice: pos.entryPrice,
          currentPrice,
          unrealizedPnl: (currentPrice - pos.entryPrice) * pos.quantity * (isBuy ? 1 : -1),
          daysHeld: Math.floor(DateTime.now().diff(pos.openedAt, 'days').days),
        },
      })

      return { decision: 'exit' }
    }

    // Hold
    const unrealizedPnl = (currentPrice - pos.entryPrice) * pos.quantity * (isBuy ? 1 : -1)
    await this.logDecision(pos.symbol, pos.tickerId, 'hold',
      `holding: P&L $${unrealizedPnl.toFixed(2)} (${((unrealizedPnl / (pos.entryPrice * pos.quantity)) * 100).toFixed(1)}%)`, {
        compositeScore: screenerData?.composite_score ?? null,
        conviction: screenerData?.conviction ?? null,
        regime: screenerData?.regime ?? null,
        algoPositionId: pos.id,
        context: { entryPrice: pos.entryPrice, currentPrice, unrealizedPnl },
      })

    return { decision: 'hold' }
  }

  // ── Entry evaluation ────────────────────────────────────────

  private async evaluateEntry(
    candidate: ScreenerTicker,
    engine: typeof QuantEngine,
    portfolioValue: number,
    currentExposurePct: number
  ): Promise<{ exposurePct: number } | null> {
    // Deep analysis for exact position sizing and SL/TP
    const analysis = await engine.analyzeTicker(candidate.symbol, { days: 365 })
    if (!analysis || !analysis.currentPrice || analysis.currentPrice <= 0) {
      await this.logDecision(candidate.symbol, await this.getTickerId(candidate.symbol), 'skip',
        'deep analysis returned no data', {
          compositeScore: candidate.composite_score,
          conviction: candidate.conviction,
          regime: candidate.regime,
        })
      return null
    }

    const rec = analysis.recommendation
    if (rec.action === 'hold') {
      await this.logDecision(candidate.symbol, await this.getTickerId(candidate.symbol), 'skip',
        `deep analysis recommends hold (score ${analysis.compositeScore})`, {
          compositeScore: analysis.compositeScore,
          conviction: rec.conviction,
          regime: rec.regime,
        })
      return null
    }

    // Position sizing: min of QuantEngine sizing and config cap
    const sizePct = Math.min(rec.positionSize, this.config.maxSinglePositionPct)
    const remainingExposure = this.config.maxExposurePct - currentExposurePct
    const effectiveSizePct = Math.min(sizePct, remainingExposure)

    if (effectiveSizePct <= 0) {
      await this.logDecision(candidate.symbol, await this.getTickerId(candidate.symbol), 'skip',
        'no remaining exposure budget', {
          compositeScore: analysis.compositeScore,
          conviction: rec.conviction,
          regime: rec.regime,
        })
      return null
    }

    // Position sizing: stocks trade in whole shares, crypto in fractions.
    // Flooring to whole shares for crypto would reject nearly every position
    // (e.g. $1000 of BTC at $100k = 0 shares).
    const isCrypto = this.config.broker === 'kraken' || this.config.broker === 'binance'
    const rawQuantity = (portfolioValue * effectiveSizePct) / analysis.currentPrice
    const quantity = isCrypto
      ? Math.floor(rawQuantity * 1e6) / 1e6
      : Math.floor(rawQuantity)

    if (quantity <= 0) {
      await this.logDecision(candidate.symbol, await this.getTickerId(candidate.symbol), 'skip',
        `position too small: $${(portfolioValue * effectiveSizePct).toFixed(0)} at $${analysis.currentPrice}`, {
          compositeScore: analysis.compositeScore,
          conviction: rec.conviction,
          regime: rec.regime,
        })
      return null
    }

    const stopLoss = rec.stopLoss || analysis.currentPrice * 0.95
    const takeProfit = rec.takeProfit || analysis.currentPrice * 1.10

    // Blend NN prediction with QuantEngine score (60% quant, 40% NN)
    const { nnScore, nnData } = this.getNNScore(candidate.symbol)
    const blendedScore = nnScore === null
      ? analysis.compositeScore
      : analysis.compositeScore * 0.6 + nnScore * 0.4
    const nnAdj = blendedScore - analysis.compositeScore

    const nnInfo = nnData
      ? `, NN: ${nnData.direction} (${(nnData.confidence * 100).toFixed(0)}% conf, r3h=${(nnData.returns.r3h * 100).toFixed(2)}%)`
      : ''
    const entryReason = `score ${blendedScore.toFixed(1)}, conviction ${(rec.conviction * 100).toFixed(0)}%, regime ${rec.regime}, ${analysis.patterns.length} patterns${nnInfo}`

    let tradeId: number | null = null
    let algoPositionId: number | null = null

    if (!this.config.dryRun) {
      const ticker = await Ticker.query().where('symbol', candidate.symbol).first()
      if (!ticker) return null

      // Create the trade
      const trade = await Trade.create({
        tickerId: ticker.id,
        symbol: candidate.symbol,
        side: 'BUY',
        orderType: this.config.orderType as any,
        quantity,
        broker: this.config.broker as any,
        status: 'pending',
        exchange: this.config.broker === 'kraken' || this.config.broker === 'binance' ? 'spot' : 'SMART',
        currency: 'USD',
        filledQuantity: 0,
        timeInForce: this.config.timeInForce,
      })
      tradeId = trade.id

      // Create algo position — pending_entry until the order actually fills,
      // so unfilled entries don't consume exposure, trigger exits, or count
      // as real positions. reconcilePositions promotes it to 'open' on fill.
      const algoPos = await AlgoPosition.create({
        tickerId: ticker.id,
        symbol: candidate.symbol,
        side: 'BUY',
        quantity,
        entryPrice: analysis.currentPrice,
        currentPrice: analysis.currentPrice,
        stopLoss,
        takeProfit,
        entryScore: analysis.compositeScore,
        entryConviction: rec.conviction,
        entryRegime: rec.regime,
        entryReason,
        entryTradeId: trade.id,
        status: 'pending_entry',
        forceClose: false,
        openedAt: DateTime.now(),
      })
      algoPositionId = algoPos.id

      // Submit the order
      await QueueService.addJob(QUEUE_NAMES.SUBMIT_ORDER, { tradeId: trade.id })
    }

    await this.logDecision(candidate.symbol, await this.getTickerId(candidate.symbol), 'enter', entryReason, {
      side: 'BUY',
      quantity,
      compositeScore: blendedScore,
      conviction: rec.conviction,
      regime: rec.regime,
      positionSizePct: effectiveSizePct,
      stopLoss,
      takeProfit,
      tradeId,
      algoPositionId,
      context: {
        price: analysis.currentPrice,
        rsi14: analysis.rsi14,
        sentimentScore: analysis.sentiment?.avgScore,
        patterns: analysis.patterns.map((p) => p.name),
        riskReward: rec.riskRewardRatio,
        quantScore: analysis.compositeScore,
        nnAdjustment: nnAdj,
        nnPrediction: nnData ? { direction: nnData.direction, confidence: nnData.confidence, returns: nnData.returns } : null,
      },
    })

    return { exposurePct: effectiveSizePct }
  }

  // ── Position reconciliation ─────────────────────────────────

  public async reconcilePositions(): Promise<void> {
    const [pendingPositions, openPositions, closingPositions] = await Promise.all([
      AlgoPosition.query().where('status', 'pending_entry').preload('entryTrade'),
      AlgoPosition.query().where('status', 'open').preload('entryTrade'),
      AlgoPosition.query().where('status', 'closing').preload('exitTrade'),
    ])

    // Pending entries: promote to open on fill, close on failure, recover if stuck
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
        logger.info('[Algo] Entry filled for %s @ %s, position open', pos.symbol, pos.entryPrice)
        continue
      }

      if (TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        pos.status = 'closed'
        pos.exitReason = `entry trade ${trade.status}: ${trade.errorMessage || trade.status}`
        pos.closedAt = DateTime.now()
        pos.realizedPnl = 0
        await pos.save()
        logger.warn('[Algo] Closed position %s: entry trade %s', pos.symbol, trade.status)
        continue
      }

      // Entry order stuck in a non-terminal state (broker hiccup, lost job)
      await this.recoverStuckTrade(trade)
      if ((trade.status as TradeStatus) === 'filled') {
        pos.status = 'open'
        if (trade.fillPrice) {
          pos.entryPrice = trade.fillPrice
          pos.currentPrice = trade.fillPrice
        }
        await pos.save()
      } else if (TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        pos.status = 'closed'
        pos.exitReason = `entry trade ${trade.status}: ${trade.errorMessage || trade.status}`
        pos.closedAt = DateTime.now()
        pos.realizedPnl = 0
        await pos.save()
        logger.warn('[Algo] Closed position %s: entry trade %s (recovered)', pos.symbol, trade.status)
      }
    }

    // Reconcile open entries: update entry price from fill
    for (const pos of openPositions) {
      const trade = pos.entryTrade
      if (!trade) continue

      if (trade.status === 'filled' && trade.fillPrice) {
        if (pos.entryPrice !== trade.fillPrice) {
          pos.entryPrice = trade.fillPrice
          await pos.save()
          logger.debug('[Algo] Reconciled entry price for %s: %s', pos.symbol, pos.entryPrice)
        }
      }
      if (TERMINAL_TRADE_STATUSES.includes(trade.status) && trade.status !== 'filled') {
        pos.status = 'closed'
        pos.exitReason = `entry trade ${trade.status}: ${trade.errorMessage || trade.status}`
        pos.closedAt = DateTime.now()
        pos.realizedPnl = 0
        await pos.save()
        logger.warn('[Algo] Closed position %s: entry trade %s', pos.symbol, trade.status)
      }
    }

    // Reconcile exits: finalize closed positions
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
        logger.info('[Algo] Position closed: %s P&L $%.2f', pos.symbol, pnl)
        continue
      }

      if (TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        pos.status = 'open'
        pos.exitTradeId = null
        pos.exitReason = null
        await pos.save()
        logger.warn('[Algo] Exit trade failed for %s, resetting to open', pos.symbol)
        continue
      }

      // Exit order stuck (e.g. broker disconnected, monitor job lost):
      // re-sync from broker, then try to cancel so the position can retry
      // on the next run instead of occupying a slot forever.
      await this.recoverStuckTrade(trade)
      if ((trade.status as TradeStatus) === 'filled') {
        const exitPrice = trade.fillPrice || pos.currentPrice || pos.entryPrice
        const direction = pos.side === 'BUY' ? 1 : -1
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * direction

        pos.status = 'closed'
        pos.exitPrice = exitPrice
        pos.realizedPnl = pnl
        pos.closedAt = DateTime.now()
        await pos.save()
        logger.info('[Algo] Position closed (recovered exit): %s P&L $%.2f', pos.symbol, pnl)
      } else if (TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        pos.status = 'open'
        pos.exitTradeId = null
        pos.exitReason = null
        await pos.save()
        logger.warn('[Algo] Exit trade cancelled after recovery for %s, resetting to open', pos.symbol)
      }
    }
  }

  /**
   * Recover a trade stuck in a non-terminal state for too long: re-sync with
   * the broker (REST-able brokers only), then attempt to cancel the order so
   * its position doesn't stay wedged. IBKR status arrives via socket callbacks
   * after cancelOrder, so recovery there completes on the next cycle.
   *
   * GTC limit entries are intentionally left alone: a patient limit order may
   * legitimately wait days to fill, and cancelling it every cycle would never
   * fill the position.
   */
  private async recoverStuckTrade(trade: Trade): Promise<void> {
    const ageMinutes = DateTime.now().diff(trade.createdAt, 'minutes').minutes
    if (ageMinutes < STUCK_TRADE_RECOVERY_MINUTES) return

    try {
      if (trade.broker === 'kraken' && !TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        await KrakenService.syncOrderStatusAny(trade)
      } else if (trade.broker === 'binance' && !TERMINAL_TRADE_STATUSES.includes(trade.status)) {
        await BinanceService.syncOrderStatus(trade)
      }

      if (TERMINAL_TRADE_STATUSES.includes(trade.status)) return

      if (trade.orderType === 'LMT' && (!trade.timeInForce || trade.timeInForce === 'GTC')) {
        logger.debug('[Algo] Leaving GTC limit trade %d untouched (patient entry)', trade.id)
        return
      }

      if (trade.broker === 'kraken') {
        await KrakenService.cancelOrderAny(trade)
      } else if (trade.broker === 'binance') {
        await BinanceService.cancelOrder(trade)
      } else {
        await IBKRService.cancelOrder(trade)
      }
    } catch (err) {
      logger.warn('[Algo] Stuck trade recovery failed for trade %d: %s', trade.id, (err as Error).message)
    }
  }

  // ── Performance stats ───────────────────────────────────────

  public static async getStats(): Promise<AlgoStats> {
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
    // The old peak-of-raw-P&L approach started at 0, so any opening losses were
    // invisible and the units were dollars, not a ratio.
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

  // ── Neural network predictions ──────────────────────────────

  private async fetchNNPredictions(symbols: string[]): Promise<void> {
    const apiUrl = env.get('TRAINING_API_URL', '')
    if (!apiUrl) return

    // Map symbols to Kraken pair names for the NN service
    const symbolToPair: Record<string, string> = {
      'BTC': 'XXBTZUSD', 'ETH': 'XETHZUSD', 'SOL': 'SOLUSD',
      'XRP': 'XRPUSD', 'ADA': 'ADAUSD', 'DOT': 'DOTUSD',
      'LINK': 'LINKUSD', 'AVAX': 'AVAXUSD',
    }
    const pairs = symbols
      .map((s) => symbolToPair[s] || symbolToPair[s.replace(/USD$/, '')])
      .filter(Boolean)

    if (pairs.length === 0) return

    try {
      const resp = await fetch(`${apiUrl}/predict/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs }),
        signal: AbortSignal.timeout(10000),
      })

      if (!resp.ok) {
        logger.warn('[Algo] NN API returned %d', resp.status)
        return
      }

      const data: any = await resp.json()
      for (const pred of (data.predictions || [])) {
        this.nnPredictions.set(pred.pair, pred)
      }
      logger.info('[Algo] Got %d NN predictions', this.nnPredictions.size)
    } catch (err) {
      logger.warn('[Algo] NN prediction fetch failed: %s', (err as Error).message)
    }
  }

  /**
   * Map a NN prediction to a score on the same -100..100 scale as the
   * QuantEngine composite. The old implementation returned an additive bonus
   * (max ±14.4) while claiming a 40% weight; the caller now blends properly:
   * blended = quant * 0.6 + nnScore * 0.4.
   */
  private getNNScore(symbol: string): { nnScore: number | null; nnData: NNPrediction | null } {
    // Map symbol back to Kraken pair
    const symbolToPair: Record<string, string> = {
      'BTC': 'XXBTZUSD', 'ETH': 'XETHZUSD', 'SOL': 'SOLUSD',
      'XRP': 'XRPUSD', 'ADA': 'ADAUSD', 'DOT': 'DOTUSD',
      'LINK': 'LINKUSD', 'AVAX': 'AVAXUSD',
    }
    const pair = symbolToPair[symbol] || symbolToPair[symbol.replace(/USD$/, '')]
    const pred = pair ? this.nnPredictions.get(pair) ?? null : null
    if (!pred || pred.confidence < 0.3) return { nnScore: null, nnData: pred }

    let directionMultiplier = 0
    if (pred.direction === 'up') directionMultiplier = 1
    else if (pred.direction === 'down') directionMultiplier = -1

    const nnScore = directionMultiplier * pred.confidence * 100
    return { nnScore, nnData: pred }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async getPortfolioValue(): Promise<number> {
    try {
      if (this.config.broker === 'kraken') {
        if (!KrakenService.isConnected) return 0
        const tb = await KrakenService.getTradeBalance()
        return parseFloat(tb.eb || '0')
      } else if (this.config.broker === 'binance') {
        if (!BinanceService.isConnected) return 0
        return await BinanceService.getTotalUsdtValue()
      } else {
        if (!IBKRService.isConnected) return 0
        const account = await IBKRService.getAccountSummary()
        return parseFloat(account.NetLiquidation?.value || '0')
      }
    } catch (err) {
      logger.error('[Algo] Failed to get portfolio value: %s', (err as Error).message)
      return 0
    }
  }

  private async getDailyRealizedPnl(): Promise<number> {
    const today = DateTime.now().startOf('day')
    const result = await db.rawQuery(
      'SELECT COALESCE(SUM(realized_pnl), 0) as total FROM algo_positions WHERE status = ? AND closed_at >= ?',
      ['closed', today.toSQL()]
    )
    return Number(result[0]?.[0]?.total || result[0]?.total || 0)
  }

  private getSkipReason(t: ScreenerTicker, positionedSymbols: Set<string>): string | null {
    if (positionedSymbols.has(t.symbol)) return null // Already tracked via hold
    if (this.config.excludedSymbols.includes(t.symbol)) return `excluded symbol`
    if (t.composite_score < this.config.entryScoreThreshold)
      return `score ${t.composite_score} < threshold ${this.config.entryScoreThreshold}`
    if (t.conviction < this.config.minConviction)
      return `conviction ${t.conviction} < min ${this.config.minConviction}`
    if (t.article_count < this.config.minArticles)
      return `articles ${t.article_count} < min ${this.config.minArticles}`
    if (!this.config.allowedRegimes.includes(t.regime))
      return `regime ${t.regime} not in allowed [${this.config.allowedRegimes}]`
    if (!['buy', 'strong_buy'].includes(t.signal))
      return `signal ${t.signal} not actionable`
    return `did not pass filters`
  }

  private tickerIdCache = new Map<string, number>()

  private async getTickerId(symbol: string): Promise<number> {
    if (this.tickerIdCache.has(symbol)) return this.tickerIdCache.get(symbol)!
    const ticker = await Ticker.query().where('symbol', symbol).first()
    const id = ticker?.id || 0
    this.tickerIdCache.set(symbol, id)
    return id
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
      logger.error('[Algo] Failed to log decision for %s: %s', symbol, (err as Error).message)
    }
  }
}
