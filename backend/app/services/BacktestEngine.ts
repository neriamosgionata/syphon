// ─── Deterministic event-driven backtester ────────────────────
//
// Replays historical price samples through the SAME feed + strategy
// (MomentumFeed + FastStrategy) the live loop uses, at the same decision
// cadence (loopIntervalSeconds). Live/backtest parity is the point:
// whatever passes here is what the live loop will do.
//
// Model:
// - samples are (epochMs, price) pairs, typically Binance 1s kline closes
// - decisions fire every `loopIntervalSeconds` of backtest time at the
//   price of the last sample at/behind that time (live checks the WS price
//   at tick time — same approximation)
// - market orders fill at the decision price; a taker fee applies per side
// - cash accounting: buys deduct qty*price*(1+fee), sells add qty*price*(1-fee)
// - positions still open at the end are force-closed at the last price
//
// Pure: no DB, no network, no env. Unit-testable in isolation.

import { MomentumFeed } from '#services/MomentumFeed'
import { FastStrategy, FastStrategyConfig } from '#services/FastStrategy'

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
      const gross = isBuy
        ? quantity * price - quantity * pos.entryPrice
        : quantity * pos.entryPrice - quantity * price
      const feePaid = quantity * price * cfg.feePct
      const pnl = gross - feePaid
      const costBasis = quantity * pos.entryPrice
      trades.push({
        symbol: pos.symbol,
        side: pos.side,
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        exitTime: time,
        exitPrice: price,
        quantity,
        pnl,
        pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
        feePaid,
        exitReason: reason,
        holdingSeconds: time - pos.entryTime > 0 ? Math.round((time - pos.entryTime) / 1000) : 0,
        closedAtEnd,
        partial,
      })
      if (isBuy) cash += quantity * price * (1 - cfg.feePct)
      else cash -= quantity * price * (1 + cfg.feePct)
    }

    // Decision times: every loopIntervalSeconds from the first sample.
    const intervalMs = Math.max(1, Math.round(cfg.loopIntervalSeconds * 1000))
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
        const slHit = isBuy ? minLow <= pos.stopLoss : maxHigh >= pos.stopLoss
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

        const signal = this.strategy.evaluateExit(this.feed, pos.symbol, price, t, {
          side: pos.side,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          peakPrice: pos.peakPrice,
          openedAt: pos.entryTime,
          scaledOut: pos.scaledOut,
        }, cfg.strategy)

        if (signal.peakPrice !== pos.peakPrice) pos.peakPrice = signal.peakPrice
        if (signal.trailingStop !== null && signal.trailingStop !== pos.stopLoss) {
          pos.stopLoss = signal.trailingStop
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
            const signal = this.strategy.evaluateEntry(this.feed, cfg.symbol, price, t, cfg.strategy)
            if (signal.shouldEnter && signal.stopLoss !== null && signal.takeProfit !== null) {
              let sizePct = Math.min(
                cfg.maxSinglePositionPct,
                exposureCap - exposurePct
              )
              if (cfg.riskPerTradePct && cfg.riskPerTradePct > 0 && signal.stopLossPct && signal.stopLossPct > 0) {
                sizePct = Math.min(sizePct, cfg.riskPerTradePct / signal.stopLossPct)
              }
              if (sizePct > 0) {
                const rawQty = (equity * sizePct) / price
                const quantity = Math.floor(rawQty * 1e6) / 1e6
                if (quantity > 0) {
                  cash -= quantity * price * (1 + cfg.feePct)
                  positions.push({
                    symbol: cfg.symbol,
                    side: 'BUY',
                    quantity,
                    entryPrice: price,
                    entryTime: t,
                    stopLoss: signal.stopLoss,
                    takeProfit: signal.takeProfit,
                    peakPrice: price,
                    scaledOut: false,
                  })
                  cooldowns.set(cfg.symbol, t)
                }
              }
            }
          }
        }
      }

      equityCurve.push({ t, value: equityAt(price) })
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
    }
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
