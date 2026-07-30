import { v4 as uuidv4 } from 'uuid'
import { DateTime } from 'luxon'
import Logger from '@ioc:Adonis/Core/Logger'
import Env from '@ioc:Adonis/Core/Env'
import Database from '@ioc:Adonis/Lucid/Database'
import QuantEngine, { TickerAnalysis, ScreenerResult } from 'App/Services/QuantEngine'
import IBKRService from 'App/Services/IBKRService'
import KrakenService from 'App/Services/KrakenService'
import BinanceService from 'App/Services/BinanceService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'
import NotificationService from 'App/Services/NotificationService'
import MeilisearchService from 'App/Services/MeilisearchService'
import AlgoConfig from 'App/Models/AlgoConfig'
import AlgoPosition from 'App/Models/AlgoPosition'
import Trade from 'App/Models/Trade'
import Ticker from 'App/Models/Ticker'

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
          Logger.info('[Algo] Cooldown: %.1f min since last run (min %d)', minsSinceLastRun, this.config.cooldownMinutes)
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
        Logger.warn('[Algo] CIRCUIT BREAKER: daily loss %.2f%% exceeds limit %.2f%%',
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
      const openPositions = await AlgoPosition.query().where('status', 'open')
      const closingPositions = await AlgoPosition.query().where('status', 'closing')
      result.positionsBefore = openPositions.length

      // Step 4: Run screener
      await this.progress(25, 'Running QuantEngine screener')
      const engine = new QuantEngine()
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
          const msg = `Exit evaluation error for ${pos.symbol}: ${err.message}`
          Logger.error('[Algo] %s', msg)
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
        .whereIn('status', ['open', 'closing'])
        .count('* as total')
      const activePositionCount = Number(currentOpenCount[0].$extras.total)

      // Symbols already in position or pending
      const positionedSymbols = new Set<string>()
      for (const pos of [...openPositions, ...closingPositions]) {
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
          const msg = `Entry evaluation error for ${candidate.symbol}: ${err.message}`
          Logger.error('[Algo] %s', msg)
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
      Logger.error('[Algo] Run failed: %s', err.message)
      result.errors.push(`Fatal: ${err.message}`)
    }

    result.durationMs = Date.now() - start
    Logger.info(
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
    engine: QuantEngine,
    portfolioValue: number
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
    engine: QuantEngine,
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

    const quantity = Math.floor((portfolioValue * effectiveSizePct) / analysis.currentPrice)
    if (quantity < 1) {
      await this.logDecision(candidate.symbol, await this.getTickerId(candidate.symbol), 'skip',
        `position too small: $${(portfolioValue * effectiveSizePct).toFixed(0)} < 1 share at $${analysis.currentPrice}`, {
          compositeScore: analysis.compositeScore,
          conviction: rec.conviction,
          regime: rec.regime,
        })
      return null
    }

    const stopLoss = rec.stopLoss || analysis.currentPrice * 0.95
    const takeProfit = rec.takeProfit || analysis.currentPrice * 1.10

    // Blend NN prediction if available (QuantEngine 60%, NN 40%)
    const { adjustment: nnAdj, nnData } = this.getNNScoreAdjustment(candidate.symbol)
    const blendedScore = analysis.compositeScore + nnAdj

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

      // Create algo position
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
        status: 'open',
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
    // Reconcile entries: update entry price from fill
    const openPositions = await AlgoPosition.query()
      .where('status', 'open')
      .preload('entryTrade')

    for (const pos of openPositions) {
      if (pos.entryTrade?.status === 'filled' && pos.entryTrade.fillPrice) {
        if (pos.entryPrice !== pos.entryTrade.fillPrice) {
          pos.entryPrice = pos.entryTrade.fillPrice
          await pos.save()
          Logger.debug('[Algo] Reconciled entry price for %s: %s', pos.symbol, pos.entryPrice)
        }
      }
      // If entry trade failed, close the algo position
      if (pos.entryTrade?.status === 'error' || pos.entryTrade?.status === 'cancelled') {
        pos.status = 'closed'
        pos.exitReason = `entry trade ${pos.entryTrade.status}: ${pos.entryTrade.errorMessage || 'cancelled'}`
        pos.closedAt = DateTime.now()
        pos.realizedPnl = 0
        await pos.save()
        Logger.warn('[Algo] Closed position %s: entry trade %s', pos.symbol, pos.entryTrade.status)
      }
    }

    // Reconcile exits: finalize closed positions
    const closingPositions = await AlgoPosition.query()
      .where('status', 'closing')
      .preload('exitTrade')

    for (const pos of closingPositions) {
      if (!pos.exitTrade) continue

      if (pos.exitTrade.status === 'filled') {
        const exitPrice = pos.exitTrade.fillPrice || pos.currentPrice || pos.entryPrice
        const direction = pos.side === 'BUY' ? 1 : -1
        const pnl = (exitPrice - pos.entryPrice) * pos.quantity * direction

        pos.status = 'closed'
        pos.exitPrice = exitPrice
        pos.realizedPnl = pnl
        pos.closedAt = DateTime.now()
        await pos.save()
        Logger.info('[Algo] Position closed: %s P&L $%.2f', pos.symbol, pnl)
      }

      // If exit trade failed, reset to open for retry on next cycle
      if (pos.exitTrade.status === 'error' || pos.exitTrade.status === 'cancelled') {
        pos.status = 'open'
        pos.exitTradeId = null
        pos.exitReason = null
        await pos.save()
        Logger.warn('[Algo] Exit trade failed for %s, resetting to open', pos.symbol)
      }
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

    // For drawdown calculation
    let peak = 0
    let cumPnl = 0
    let maxDrawdown = 0

    for (const pos of closed) {
      const pnl = Number(pos.realizedPnl) || 0
      totalPnl += pnl
      cumPnl += pnl

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

      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / peak : 0
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
    const apiUrl = Env.get('TRAINING_API_URL', '')
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
        Logger.warn('[Algo] NN API returned %d', resp.status)
        return
      }

      const data = await resp.json()
      for (const pred of (data.predictions || [])) {
        this.nnPredictions.set(pred.pair, pred)
      }
      Logger.info('[Algo] Got %d NN predictions', this.nnPredictions.size)
    } catch (err) {
      Logger.warn('[Algo] NN prediction fetch failed: %s', err.message)
    }
  }

  private getNNScoreAdjustment(symbol: string): { adjustment: number; nnData: NNPrediction | null } {
    // Map symbol back to Kraken pair
    const symbolToPair: Record<string, string> = {
      'BTC': 'XXBTZUSD', 'ETH': 'XETHZUSD', 'SOL': 'SOLUSD',
      'XRP': 'XRPUSD', 'ADA': 'ADAUSD', 'DOT': 'DOTUSD',
      'LINK': 'LINKUSD', 'AVAX': 'AVAXUSD',
    }
    const pair = symbolToPair[symbol] || symbolToPair[symbol.replace(/USD$/, '')]
    const pred = pair ? this.nnPredictions.get(pair) : null
    if (!pred || pred.confidence < 0.3) return { adjustment: 0, nnData: pred }

    // NN weight: 40% of composite, QuantEngine: 60%
    // Convert NN direction + confidence to a score adjustment (-40 to +40)
    let directionMultiplier = 0
    if (pred.direction === 'up') directionMultiplier = 1
    else if (pred.direction === 'down') directionMultiplier = -1

    const adjustment = directionMultiplier * pred.confidence * 40 * 0.4
    return { adjustment, nnData: pred }
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
        const account = await BinanceService.getAccountInfo()
        const usdt = account.balances?.find((b: any) => b.asset === 'USDT')
        return parseFloat(usdt?.free || '0') + parseFloat(usdt?.locked || '0')
      } else {
        if (!IBKRService.isConnected) return 0
        const account = await IBKRService.getAccountSummary()
        return parseFloat(account.NetLiquidation?.value || '0')
      }
    } catch (err) {
      Logger.error('[Algo] Failed to get portfolio value: %s', err.message)
      return 0
    }
  }

  private async getDailyRealizedPnl(): Promise<number> {
    const today = DateTime.now().startOf('day')
    const result = await Database.rawQuery(
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
      Logger.error('[Algo] Failed to log decision for %s: %s', symbol, err.message)
    }
  }
}
