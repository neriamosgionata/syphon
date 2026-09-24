// ─── Deterministic event-driven backtester ────────────────────
//
// Replays historical price samples through the SAME feed + strategy
// (MomentumFeed + FastStrategy) the live loop uses, at the same decision
// cadence (loopIntervalSeconds). Live/backtest parity is the point:
// whatever passes here is what the live loop will do.
//
// Model:
// - samples are (epochMs, price) pairs, typically OHLC bar closes
// - decisions fire every `loopIntervalSeconds` of backtest time at the
//   price of the last sample at/behind that time (live checks the WS price
//   at tick time — same approximation)
// - market orders fill at the decision price; a taker fee applies per side
// - cash accounting: buys deduct qty*price*(1+fee), sells add qty*price*(1-fee)
// - positions still open at the end are force-closed at the last price
//
// Pure: no DB, no network, no env. Unit-testable in isolation.

import { MomentumFeed } from '#services/MomentumFeed'
import { FastStrategy, FastStrategyConfig, NewsContext, JevContext, volatilityMultiplier } from '#services/FastStrategy'
import { newsWindowScore } from '#services/NewsScore'

/**
 * Replay visibility bound (ms) — mirrors the live Jev stale-reuse window.
 * A recorded score older than this at decision time is invisible to the
 * replay, exactly as the live loop nulls past the reuse window.
 */
export const JEV_REPLAY_STALE_MS = 90_000

/**
 * Recorded Jev score replayed at the decision cadence. Only the latest
 * ENFORCED event at or behind the decision time is visible (point-in-time
 * discipline); shadow-recorded rows (enforced: false) never certify.
 * Mixing model/question versions in one window is rejected, never blended.
 */
export interface JevReplayEvent {
  t: number
  pUp: number | null
  pDown: number | null
  confidence: number | null
  model: string
  questionHash?: string
  promptVersion?: string
  stale?: boolean
  enforced?: boolean
}

export interface BacktestSample {
  t: number
  p: number
  /** Optional 1s-bar high/low — enables intrabar stop/target fills. */
  h?: number
  l?: number
  /** Optional 1s-bar volume — feeds the volume confirmation gate. */
  v?: number
}

export interface BacktestConfig {
  symbol: string
  strategy: FastStrategyConfig
  /** Decision cadence in seconds — set to the live fast_interval_seconds. */
  loopIntervalSeconds: number
  /** Starting portfolio value in USD. */
  portfolioUsd: number
  /** Taker fee per side, e.g. 0.0026 = 0.26%. */
  feePct: number
  maxPositions: number
  maxExposurePct: number
  maxSinglePositionPct: number
  cooldownSeconds: number
  /** Cap on TOTAL exposure across the (correlated) basket. 0 = maxExposurePct. */
  correlatedExposurePct?: number
  /** Size so a full SL stop risks this % of equity. 0 = off. */
  riskPerTradePct?: number
  /** Pause entries after this many consecutive losing closes. 0 = off. */
  maxLossStreak?: number
  /** Pause duration after hitting maxLossStreak. 0 = until the next win. */
  lossStreakPauseSeconds?: number
  /**
   * Maker execution: enter via limit, fill if touched within this window (s). 0 = MARKET.
   * NOTE: on coarse bars a fill window shorter than the sample interval can
   * never fill (no bar trades inside it) — the engine falls back to MARKET
   * when limitFillSeconds < the bar interval.
   */
  limitFillSeconds?: number
  /** Buy limit placed this % above the decision price. */
  limitOffsetPct?: number
  /** Fee for limit fills (maker). Falls back to feePct. */
  makerFeePct?: number
  /** Volatility targeting: exposure scaled so realized vol matches target. 0 = off. */
  volTargetPct?: number
  /** Realized-vol window in 1s samples. */
  volTargetWindowSeconds?: number
  /** Max exposure multiplier from vol targeting. */
  volTargetMaxMult?: number
  /**
   * Execution slippage in basis points per side — market fills get
   * price × (1 ± slip), stop/target fills fill at the level minus slippage.
   * The taker fee is charged on the slipped fill price. 0 = no slippage
   * (optimistic — the honest baseline is > 0).
   */
  slippageBps?: number
  /**
   * Trailing-stop confirmation window in seconds (0 = fire on the first
   * breach — the default). Once the trailing stop has armed, a breach
   * (intrabar low or close at/below the ratcheted level) must persist this
   * long before the exit fires; recovering above the level resets it. Kills
   * single-bar whipsaw exits on fine (1m) decision cadences. Execution-layer
   * only — the pure strategy is unchanged.
   */
  trailConfirmSeconds?: number
  /**
   * Historical news events (epoch ms + sentiment in [-1,1]) replayed at
   * the decision cadence. When the strategy's news gate is enabled, each
   * decision sees newsWindowScore over the events known AT that time —
   * the exact aggregation the live loop runs (NewsSentimentService).
   * Omit = the test has no news; the gate can never block (matches live
   * behavior on a quiet news day). WARNING: enabling the gate without
   * providing news data silently disables the gate — parity requires the
   * news to exist in the test.
   */
  newsEvents?: Array<{ t: number; score: number; weight?: number; id?: string }>
  /**
   * Recorded Jev scores (epoch ms + calibrated read + provenance) replayed
   * at the decision cadence through the same gate the live loop runs. Omit
   * = no recorded scores; an enabled gate then runs off with a notice
   * (matches live behavior when the scorer is down). WARNING: enabling the
   * gate without providing scores silently disables the gate — parity
   * requires the scores to exist in the test.
   */
  jevEvents?: JevReplayEvent[]
}

export interface BacktestTrade {
  symbol: string
  side: 'BUY' | 'SELL'
  entryTime: number
  entryPrice: number
  exitTime: number | null
  exitPrice: number | null
  quantity: number
  pnl: number
  pnlPct: number
  feePaid: number
  exitReason: string | null
  holdingSeconds: number | null
  /** True when the position was still open at end of test and force-closed. */
  closedAtEnd: boolean
  /** Scale-out partial close — excluded from win/loss counts, included in PnL. */
  partial?: boolean
}

export interface BacktestMetrics {
  totalTrades: number
  winCount: number
  lossCount: number
  winRate: number
  totalPnl: number
  avgPnlPct: number
  largestWin: number
  largestLoss: number
  profitFactor: number
  avgHoldingSeconds: number | null
  maxDrawdownPct: number
}

export interface BacktestResult {
  symbol: string
  samples: number
  startTime: number
  endTime: number
  startUsd: number
  endUsd: number
  strategyReturnPct: number
  buyHoldReturnPct: number
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equityCurve: Array<{ t: number; value: number }>
  /**
   * Set when the Jev gate was enabled but no recorded scores existed in
   * scope — the gate ran off and the report is deterministic-only. Null
   * when scores replayed or the gate was off.
   */
  jevNotice?: string | null
}

interface OpenPosition {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  entryPrice: number
  entryTime: number
  stopLoss: number
  takeProfit: number
  peakPrice: number
  scaledOut: boolean
  /** True once the trailing stop has ratcheted the stop level (gates confirm). */
  trailArmed: boolean
  /** Epoch ms the armed trail was first breached — null when above it. */
  trailBreachSince?: number | null
}

export class BacktestEngine {
  private feed = new MomentumFeed()
  private strategy = new FastStrategy()

  public run(samples: BacktestSample[], cfg: BacktestConfig): BacktestResult {
    if (samples.length < 2) {
      throw new Error('BacktestEngine: need at least 2 samples')
    }
    // The feed is a class field so run() must be re-entrant: previous runs
    // (and any strategy warm-up) must not leak into this one.
    this.feed.clearAll()
    // Coarse bars carry no information between samples — decide once per
    // sample interval at most (a 10s loop over 1m bars would just replay
    // the same close 6×, costing 6× CPU for identical decisions).
    const intervalSeconds = Math.min(Math.max(cfg.strategy.sampleIntervalSeconds || 1, 1), 3600)
    // Trim the feed to the longest lookback any indicator needs so multi-
    // year 1m runs don't rescan the whole series every decision tick.
    this.feed.setMaxSamples(this.feedSamplesNeeded(cfg, intervalSeconds))
    const series = [...samples].sort((a, b) => a.t - b.t)
    const startTime = series[0].t
    const endTime = series[series.length - 1].t
    const firstPrice = series[0].p
    const lastPrice = series[series.length - 1].p

    let cash = cfg.portfolioUsd
    const positions: OpenPosition[] = []
    const trades: BacktestTrade[] = []
    const equityCurve: Array<{ t: number; value: number }> = []
    const cooldowns = new Map<string, number>()
    let lossStreak = 0
    let streakSinceAt = 0
    let feedIndex = 0
    let prevFeedIndex = 0
    let newsIndex = 0
    const news = cfg.newsEvents
      ? [...cfg.newsEvents].sort((a, b) => a.t - b.t).map((e, i) => ({ ...e, id: e.id ?? `n${i}` }))
      : null
    // Jev replay state (same re-entrancy discipline as the feed: locals per
    // run, never instance state). Mixed model/question versions are
    // rejected — blending them would certify an edge no single model earned.
    let jevIndex = 0
    let jevNotice: string | null = null
    let jevApplied = false
    const jev = cfg.jevEvents ? [...cfg.jevEvents].sort((a, b) => a.t - b.t) : null
    if (jev && jev.length > 0) {
      const versions = new Set(jev.map((e) => `${e.model}|${e.questionHash ?? ''}|${e.promptVersion ?? ''}`))
      if (versions.size > 1) {
        throw new Error('BacktestEngine: refusing to blend Jev scores across model/question versions')
      }
    }

    // Slippage: market fills at price × (1 ± bps/10000). Buys slip up,
    // sells slip down — always against the trader.
    const slip = (cfg.slippageBps || 0) / 10000
    const buyFill = (p: number): number => p * (1 + slip)
    const sellFill = (p: number): number => p * (1 - slip)
    const fillFor = (p: number, isBuy: boolean): number => (isBuy ? buyFill(p) : sellFill(p))

    const equityAt = (price: number): number =>
      cash + positions.reduce((s, p) => s + p.quantity * price, 0)

    const closePosition = (
      pos: OpenPosition,
      price: number,
      time: number,
      reason: string,
      closedAtEnd: boolean,
      quantity = pos.quantity,
      partial = false
    ): void => {
      const isBuy = pos.side === 'BUY'
      // Slippage against the trader: closing a BUY sells at a worse price.
      const fillPrice = isBuy ? sellFill(price) : buyFill(price)
      const gross = isBuy
        ? quantity * fillPrice - quantity * pos.entryPrice
        : quantity * pos.entryPrice - quantity * fillPrice
      const feePaid = quantity * fillPrice * cfg.feePct
      const pnl = gross - feePaid
      const costBasis = quantity * pos.entryPrice
      trades.push({
        symbol: pos.symbol,
        side: pos.side,
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        exitTime: time,
        exitPrice: fillPrice,
        quantity,
        pnl,
        pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
        feePaid,
        exitReason: reason,
        holdingSeconds: time - pos.entryTime > 0 ? Math.round((time - pos.entryTime) / 1000) : 0,
        closedAtEnd,
        partial,
      })
      if (isBuy) cash += quantity * fillPrice * (1 - cfg.feePct)
      else cash -= quantity * fillPrice * (1 + cfg.feePct)
    }

    // Decision times: every loopIntervalSeconds from the first sample.
    const loopSeconds = Math.max(Math.round(cfg.loopIntervalSeconds), intervalSeconds)
    const intervalMs = Math.max(1, Math.round(loopSeconds * 1000))
    for (let t = startTime; t <= endTime; t += intervalMs) {
      // Advance the feed with every sample at or behind the decision time.
      prevFeedIndex = feedIndex
      while (feedIndex < series.length && series[feedIndex].t <= t) {
        const s = series[feedIndex]
        this.feed.push(cfg.symbol, s.p, s.t, s.v)
        feedIndex++
      }
      const price = this.feed.lastPrice(cfg.symbol)
      if (price === null) continue

      // News context at THIS decision time: only events already published
      // count, aggregated with the live loop's exact math (recency decay,
      // window filter, distinct-event dedup).
      let newsContext: NewsContext | null = null
      if (news && cfg.strategy.newsGateEnabled) {
        while (newsIndex < news.length && news[newsIndex].t <= t) newsIndex++
        const result = newsWindowScore(news.slice(0, newsIndex), t, cfg.strategy.newsWindowSeconds)
        newsContext = { score: result.score, events: result.events }
      }

      // Jev context at THIS decision time: the latest enforced event at or
      // behind t, ignoring events older than the live reuse window.
      // Staleness marks age past the window; it does not widen visibility —
      // only recorded history decides.
      let jevContext: JevContext | null = null
      if (cfg.strategy.jevGateEnabled) {
        if (jev && jev.length > 0) {
          while (jevIndex < jev.length && jev[jevIndex].t <= t) jevIndex++
          for (let j = jevIndex - 1; j >= 0; j--) {
            const event = jev[j]
            if (event.enforced === false) continue
            if (t - event.t > JEV_REPLAY_STALE_MS) continue
            jevContext = {
              pUp: event.pUp,
              pDown: event.pDown,
              confidence: event.confidence,
              stale: t - event.t > 90_000,
            }
            jevApplied = true
            break
          }
        } else if (!jevNotice) {
          jevNotice = 'jev gate enabled but no recorded Jev scores in scope — gate ran off'
        }
      }

      // Intrabar extremes since the last decision — stops/targets can fill
      // mid-bar, not only at the decision close.
      let minLow = Infinity
      let maxHigh = -Infinity
      for (let i = prevFeedIndex; i < feedIndex; i++) {
        const s = series[i]
        const low = s.l !== undefined ? s.l : s.p
        const high = s.h !== undefined ? s.h : s.p
        if (low < minLow) minLow = low
        if (high > maxHigh) maxHigh = high
      }

      // Exits first (risk reduction before risk addition — same as live).
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i]
        const isBuy = pos.side === 'BUY'
        let exited = false

        // Intrabar SL/TP fills at the level price (SL wins if both hit).
        const confirmMs = (cfg.trailConfirmSeconds || 0) * 1000
        const trailGated = pos.trailArmed && confirmMs > 0
        let slHit = isBuy ? minLow <= pos.stopLoss : maxHigh >= pos.stopLoss
        if (slHit && trailGated) {
          // Armed-trail breach: defer until it persists the confirm window.
          if (pos.trailBreachSince === undefined || pos.trailBreachSince === null) pos.trailBreachSince = t
          if (t - pos.trailBreachSince < confirmMs) slHit = false
        }
        if (slHit) {
          closePosition(pos, pos.stopLoss, t, `stop-loss (intrabar): ${pos.stopLoss.toFixed(2)}`, false)
          positions.splice(i, 1)
          exited = true
        }
        if (!exited && pos.takeProfit > 0) {
          const tpHit = isBuy ? maxHigh >= pos.takeProfit : minLow <= pos.takeProfit
          if (tpHit) {
            closePosition(pos, pos.takeProfit, t, `take-profit (intrabar): ${pos.takeProfit.toFixed(2)}`, false)
            positions.splice(i, 1)
            exited = true
          }
        }
        if (exited) {
          const trade = trades[trades.length - 1]
          if (trade && !trade.partial) {
            if (trade.pnl > 0) {
              lossStreak = 0
            } else {
              lossStreak++
              if (cfg.maxLossStreak && lossStreak >= cfg.maxLossStreak) streakSinceAt = t
            }
          }
          continue
        }

        let signal = this.strategy.evaluateExit(this.feed, pos.symbol, price, t, {
          side: pos.side,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          peakPrice: pos.peakPrice,
          openedAt: pos.entryTime,
          scaledOut: pos.scaledOut,
        }, cfg.strategy, jevContext)

        if (signal.peakPrice !== pos.peakPrice) pos.peakPrice = signal.peakPrice
        if (signal.trailingStop !== null && signal.trailingStop !== pos.stopLoss) {
          pos.stopLoss = signal.trailingStop
          pos.trailArmed = true
        }

        // Scale-out: lock in a fraction of the winner when the trail arms.
        if (signal.scaleOut && !pos.scaledOut) {
          const fraction = cfg.strategy.scaleOutPct > 0 ? Math.min(1, cfg.strategy.scaleOutPct) : 0
          if (fraction > 0 && fraction < 1) {
            const qtyOut = Math.floor(pos.quantity * fraction * 1e6) / 1e6
            if (qtyOut > 0) {
              closePosition(pos, price, t, 'scale-out', false, qtyOut, true)
              pos.quantity -= qtyOut
            }
          }
          pos.scaledOut = true
        }

        if (signal.shouldExit) {
          const isStopExit = (signal.reason || '').startsWith('stop-loss') || (signal.reason || '').startsWith('trailing stop')
          if (trailGated && isStopExit) {
            if (pos.trailBreachSince === undefined || pos.trailBreachSince === null) pos.trailBreachSince = t
            if (t - pos.trailBreachSince < confirmMs) {
              signal = { ...signal, shouldExit: false, reason: null }
            }
          }
        }
        // Recovered above the trail — clear any pending breach marker.
        if (trailGated) {
          const stillBreached = isBuy ? minLow <= pos.stopLoss : maxHigh >= pos.stopLoss
          if (!stillBreached) pos.trailBreachSince = null
        }
        if (signal.shouldExit) {
          closePosition(pos, price, t, signal.reason || 'strategy exit', false)
          positions.splice(i, 1)
          // Loss streak accounting on full closes (the trade was just pushed).
          const trade = trades[trades.length - 1]
          if (trade && !trade.partial) {
            if (trade.pnl > 0) {
              lossStreak = 0
            } else {
              lossStreak++
              if (cfg.maxLossStreak && lossStreak >= cfg.maxLossStreak) streakSinceAt = t
            }
          }
        }
      }

      // Entries. One position per symbol — the live loop skips symbols
      // that already have a position, and the engine must match.
      if (positions.length < cfg.maxPositions && !positions.some((p) => p.symbol === cfg.symbol)) {
        const equity = equityAt(price)
        let exposure = positions.reduce((s, p) => s + p.quantity * price, 0)
        let exposurePct = equity > 0 ? exposure / equity : 0

        const exposureCap = cfg.correlatedExposurePct && cfg.correlatedExposurePct > 0
          ? Math.min(cfg.maxExposurePct, cfg.correlatedExposurePct)
          : cfg.maxExposurePct

        // Loss-streak pause: no entries while the streak persists (unless a
        // time-based pause has elapsed, then reset and resume).
        let streakBlocked = false
        if (cfg.maxLossStreak && cfg.maxLossStreak > 0 && lossStreak >= cfg.maxLossStreak) {
          if (!cfg.lossStreakPauseSeconds || cfg.lossStreakPauseSeconds <= 0) {
            streakBlocked = true
          } else if (t - streakSinceAt < cfg.lossStreakPauseSeconds * 1000) {
            streakBlocked = true
          } else {
            lossStreak = 0
          }
        }

        if (exposurePct < exposureCap && !streakBlocked) {
          const lastEntry = cooldowns.get(cfg.symbol) || 0
          if (t - lastEntry >= cfg.cooldownSeconds * 1000) {
            const signal = this.strategy.evaluateEntry(this.feed, cfg.symbol, price, t, cfg.strategy, newsContext, jevContext)
            if (signal.shouldEnter && signal.stopLoss !== null && signal.takeProfit !== null) {
              let sizePct = Math.min(
                cfg.maxSinglePositionPct,
                exposureCap - exposurePct
              )
              if (cfg.riskPerTradePct && cfg.riskPerTradePct > 0 && signal.stopLossPct && signal.stopLossPct > 0) {
                sizePct = Math.min(sizePct, cfg.riskPerTradePct / signal.stopLossPct)
              }
              // Volatility targeting: scale exposure to a target vol level.
              if (cfg.volTargetPct && cfg.volTargetPct > 0 && cfg.volTargetWindowSeconds && cfg.volTargetWindowSeconds > 0) {
                const volWindow = Math.max(1, Math.round(cfg.volTargetWindowSeconds / intervalSeconds))
                const volPct = cfg.strategy.harVolForecast
                  ? this.feed.harVolatilityPct(cfg.symbol, volWindow, volWindow * 10, volWindow * 60, t)
                  : this.feed.volatilityPct(cfg.symbol, volWindow, t)
                const mult = volatilityMultiplier(volPct, cfg.volTargetPct, cfg.volTargetMaxMult || 2, intervalSeconds)
                // Scale but never exceed the per-position cap.
                sizePct = Math.min(sizePct * mult, cfg.maxSinglePositionPct)
              }
              // Conviction sizing: stronger signal, bigger size (bounded).
              const conviction = this.strategy.convictionMultiplier(signal, cfg.strategy)
              sizePct = Math.min(sizePct * conviction, cfg.maxSinglePositionPct)
              // Jev shrink-only sizing (same map the live loop runs — replay
              // has no shadow mode; stored scores are the enforced path).
              const jevMult = this.strategy.jevConvictionMultiplier(jevContext, cfg.strategy)
              sizePct = Math.min(sizePct * jevMult, cfg.maxSinglePositionPct)
              if (sizePct > 0) {
                const rawQty = (equity * sizePct) / price
                const quantity = Math.floor(rawQty * 1e6) / 1e6
                if (quantity > 0) {
                  // A limit-fill window shorter than one bar can never fill
                  // on coarse samples — fall back to MARKET in that case.
                  const makerMode = !!cfg.limitFillSeconds && cfg.limitFillSeconds >= intervalSeconds
                  const entryFee = makerMode ? (cfg.makerFeePct ?? cfg.feePct) : cfg.feePct
                  const limit = price * (1 + (cfg.limitOffsetPct ?? 0) / 100)

                  if (makerMode) {
                    // Maker entry: fill only if the market trades through the
                    // limit within the fill window (realistic limit model).
                    const fillEnd = t + cfg.limitFillSeconds * 1000
                    let fillIdx = -1
                    for (let j = feedIndex; j < series.length; j++) {
                      if (series[j].t > fillEnd) break
                      const low = series[j].l !== undefined ? series[j].l : series[j].p
                      if (low <= limit) { fillIdx = j; break }
                    }
                    cooldowns.set(cfg.symbol, t)
                    if (fillIdx === -1) continue // unfilled — miss, no position
                    // SL/TP scale with the actual fill price (limit != decision).
                    const fillRatio = limit / price
                    cash -= quantity * limit * (1 + entryFee)
                    positions.push({
                      symbol: cfg.symbol,
                      side: 'BUY',
                      quantity,
                      entryPrice: limit,
                      entryTime: series[fillIdx].t,
                      stopLoss: signal.stopLoss * fillRatio,
                      takeProfit: signal.takeProfit > 0 ? signal.takeProfit * fillRatio : 0,
                      peakPrice: limit,
                      scaledOut: false,
                      trailArmed: false,
                    })
                  } else {
                    const entryFill = buyFill(price)
                    cash -= quantity * entryFill * (1 + entryFee)
                    positions.push({
                      symbol: cfg.symbol,
                      side: 'BUY',
                      quantity,
                      entryPrice: entryFill,
                      entryTime: t,
                      stopLoss: signal.stopLoss,
                      takeProfit: signal.takeProfit,
                      peakPrice: entryFill,
                      scaledOut: false,
                      trailArmed: false,
                    })
                    cooldowns.set(cfg.symbol, t)
                  }
                }
              }
            }
          }
        }
      }

      equityCurve.push({ t, value: equityAt(price) })
    }

    // A non-empty list that never certified anything (all shadow rows, or
    // all too stale to see) ran the gate off just like a scoreless window.
    if (cfg.strategy.jevGateEnabled && jev && jev.length > 0 && !jevApplied && !jevNotice) {
      jevNotice = 'jev gate enabled but no recorded Jev scores in scope — gate ran off'
    }

    // Force-close anything still open at the end.
    for (const pos of positions) {
      closePosition(pos, lastPrice, endTime, 'end_of_test', true)
    }

    const endUsd = cash
    return {
      symbol: cfg.symbol,
      samples: series.length,
      startTime,
      endTime,
      startUsd: cfg.portfolioUsd,
      endUsd,
      strategyReturnPct: cfg.portfolioUsd > 0 ? ((endUsd - cfg.portfolioUsd) / cfg.portfolioUsd) * 100 : 0,
      buyHoldReturnPct: firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0,
      metrics: this.computeMetrics(trades, equityCurve),
      trades,
      equityCurve,
      jevNotice,
    }
  }

  /**
   * Longest sample lookback the strategy can ask the feed for. The feed
   * trims to this so per-tick scans stay bounded on coarse (1m) bars; at 1s
   * the bound stays 14400 (the feed default), preserving the live shape.
   *
   * Sample-count lookbacks (EMA periods, vol/HAR windows) dominate on 1s
   * bars; on 1m bars the real-time windows (slope/CUSUM/momentum) plus a
   * period of EMA seed cover the rest.
   */
  private feedSamplesNeeded(cfg: BacktestConfig, intervalSeconds: number): number {
    const s = cfg.strategy
    const bars = (seconds: number): number => (seconds > 0 ? Math.max(1, Math.round(seconds / intervalSeconds)) : 0)
    const max = Math.max(
      s.emaPeriod,
      s.regimeEmaPeriod,
      s.choppinessPeriod,
      s.volumeWindowSamples,
      s.volatilityWindowSamples * (s.harVolForecast ? 60 : 1),
      s.emaPeriod + bars(s.trendSlopeWindowSeconds),
      s.regimeEmaPeriod + bars(s.regimeSlopeWindowSeconds),
      s.emaPeriod + bars(s.cusumWindowSeconds),
      bars(s.momentumSeconds) + 1,
      s.efficiencyWindowDays > 0 ? Math.ceil((s.efficiencyWindowDays * 86_400) / intervalSeconds) : 0,
      cfg.volTargetPct && cfg.volTargetPct > 0 && cfg.volTargetWindowSeconds
        ? Math.max(1, Math.round(cfg.volTargetWindowSeconds / intervalSeconds)) * 60
        : 0,
      24
    )
    // 1s runs keep the live 14400-sample buffer untouched.
    return intervalSeconds === 1 ? 14400 : Math.min(max + 4, 14400)
  }

  private computeMetrics(
    trades: BacktestTrade[],
    equityCurve: Array<{ t: number; value: number }>
  ): BacktestMetrics {
    let winCount = 0
    let lossCount = 0
    let totalPnl = 0
    let grossWins = 0
    let grossLosses = 0
    let totalReturnPct = 0
    let totalHold = 0
    let largestWin = 0
    let largestLoss = 0

    for (const trade of trades) {
      totalPnl += trade.pnl
      // Partial scale-outs don't count as round trips (win rate / PF would
      // double-count the same position), but their PnL is real.
      if (trade.partial) continue
      totalReturnPct += trade.pnlPct
      if (trade.holdingSeconds !== null) totalHold += trade.holdingSeconds
      if (trade.pnl > 0) {
        winCount++
        grossWins += trade.pnl
        if (trade.pnl > largestWin) largestWin = trade.pnl
      } else {
        lossCount++
        grossLosses += Math.abs(trade.pnl)
        if (trade.pnl < largestLoss) largestLoss = trade.pnl
      }
    }

    // Max drawdown from the equity curve (percent).
    let peak = -Infinity
    let maxDrawdown = 0
    for (const point of equityCurve) {
      if (point.value > peak) peak = point.value
      if (peak > 0) {
        const dd = ((peak - point.value) / peak) * 100
        if (dd > maxDrawdown) maxDrawdown = dd
      }
    }

    const total = trades.length
    return {
      totalTrades: total,
      winCount,
      lossCount,
      winRate: total > 0 ? winCount / total : 0,
      totalPnl,
      avgPnlPct: total > 0 ? totalReturnPct / total : 0,
      largestWin,
      largestLoss,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      avgHoldingSeconds: total > 0 ? totalHold / total : null,
      maxDrawdownPct: maxDrawdown,
    }
  }
}

export default new BacktestEngine()
