// ─── Pure intraminute strategy core ───────────────────────────
//
// Deterministic, I/O-free entry/exit decision logic for the fast algo.
// No DB, no WS, no engine, no env — everything comes in through the
// function arguments. The live loop (FastAlgoService) and the backtester
// (BacktestEngine) both call this, so live behaviour and backtest
// behaviour are the same code path.
//
// Entry gates (all must pass):
//   1. momentum + RSI   (MomentumFeed.score — momentum over window,
//                        Wilder RSI-7 within [rsiLow, rsiHigh])
//   2. EMA trend filter (price above EMA when emaPeriod > 0; lenient
//                        while the EMA is still warming up)
//   3. volatility ceiling (skip when measured vol exceeds the ceiling)
//
// Exit rules (checked in priority order):
//   1. stop loss        (fixed price level; ratcheted by trailing stop)
//   2. take profit      (fixed price level)
//   3. trailing stop    (arms once profit >= activatePct, trails
//                        trailingStopPct behind the peak)
//   4. max hold         (force-close after maxHoldSeconds)
//   5. momentum reversal (momentum drops to/below exitReversalPct)

import { MomentumFeed, MomentumScore } from '#services/MomentumFeed'

export interface FastStrategyConfig {
  momentumSeconds: number
  momentumThresholdPct: number
  rsiLow: number
  rsiHigh: number
  stopLossPct: number
  takeProfitPct: number
  exitReversalPct: number
  /** Trailing distance in % behind the peak. 0 = off. */
  trailingStopPct: number
  /** Profit % (from entry) that arms the trailing stop. 0 = off. */
  trailingActivatePct: number
  /** Force-close after this many seconds. 0 = off. */
  maxHoldSeconds: number
  /** EMA trend filter period (samples). 0 = off. */
  emaPeriod: number
  /** Volatility window in samples for adaptive SL/TP. 0 = off. */
  volatilityWindowSamples: number
  /** SL distance multiplier on measured per-minute volatility. */
  volatilityMult: number
  /** Minimum per-minute volatility to consider (avoids over-tight SL). */
  volatilityFloorPct: number
  /** Skip entries when per-minute volatility exceeds this. 0 = no ceiling. */
  volatilityCeilingPct: number
  /**
   * Trend-rider mode: entry = price above EMA + EMA slope >= trendSlopePct
   * over trendSlopeWindowSeconds. Replaces the momentum+RSI gate entirely
   * (steady trends pin RSI at 100 — rejecting them is why burst mode sleeps
   * through rallies). `takeProfitPct` 0 = no take profit; ride the trailing
   * stop instead.
   */
  trendMode: boolean
  /** Min EMA slope % over trendSlopeWindowSeconds to enter. */
  trendSlopePct: number
  /** Slope measurement window in seconds. */
  trendSlopeWindowSeconds: number
  /**
   * Regime gate (trend mode only): stand aside unless a SLOWER EMA slope
   * shows the market is actually trending. 0 = off. Fixes the flat-market
   * bleed where the fast slope gate fires on chop wiggles.
   */
  regimeEmaPeriod: number
  /** Slope window for the regime EMA. */
  regimeSlopeWindowSeconds: number
  /** Min regime EMA slope % to count the market as trending. */
  regimeSlopeMinPct: number
  /**
   * Volume confirmation: entry bar volume must be >= rolling-median ×
   * ratio. 0 = off. NOTE: live Kraken WS feed carries no per-tick volume,
   * so the gate is skipped live (lenient) — backtest-only filter.
   */
  volumeWindowSamples: number
  volumeMinRatio: number
  /**
   * Trailing distance scales with volatility: effective trail =
   * max(trailingStopPct, mult × per-minute vol). 0 = off.
   */
  trailingVolatilityMult: number
  /**
   * Sell this fraction of the position when the trailing stop first arms
   * (0-1). 0 = off. The caller executes the partial close.
   */
  scaleOutPct: number
}

/**
 * Structural mapping from a persisted config row (AlgoConfig or a plain
 * object with the same field names) onto the strategy config. A value of
 * 0/null disables the corresponding control.
 */
export function fastStrategyFromConfig(cfg: {
  fastMomentumSeconds: number
  fastMomentumThresholdPct: number
  fastRsiLow: number
  fastRsiHigh: number
  fastStopLossPct: number
  fastTakeProfitPct: number
  fastExitReversalPct: number
  fastTrailingStopPct?: number | null
  fastTrailingActivatePct?: number | null
  fastMaxHoldSeconds?: number | null
  fastEmaPeriod?: number | null
  fastVolatilityWindowSeconds?: number | null
  fastVolatilityMult?: number | null
  fastVolatilityFloorPct?: number | null
  fastVolatilityCeilingPct?: number | null
  fastTrendMode?: boolean | number | null
  fastTrendSlopePct?: number | null
  fastTrendSlopeWindowSeconds?: number | null
  fastRegimeEmaPeriod?: number | null
  fastRegimeSlopeWindowSeconds?: number | null
  fastRegimeSlopeMinPct?: number | null
  fastVolumeWindowSeconds?: number | null
  fastVolumeMinRatio?: number | null
  fastTrailingVolatilityMult?: number | null
  fastScaleOutPct?: number | null
}): FastStrategyConfig {
  return {
    momentumSeconds: cfg.fastMomentumSeconds,
    momentumThresholdPct: cfg.fastMomentumThresholdPct,
    rsiLow: cfg.fastRsiLow,
    rsiHigh: cfg.fastRsiHigh,
    stopLossPct: cfg.fastStopLossPct,
    takeProfitPct: cfg.fastTakeProfitPct,
    exitReversalPct: cfg.fastExitReversalPct,
    trailingStopPct: cfg.fastTrailingStopPct ?? 0,
    trailingActivatePct: cfg.fastTrailingActivatePct ?? 0,
    maxHoldSeconds: cfg.fastMaxHoldSeconds ?? 0,
    emaPeriod: cfg.fastEmaPeriod ?? 0,
    volatilityWindowSamples: cfg.fastVolatilityWindowSeconds ?? 0,
    volatilityMult: cfg.fastVolatilityMult ?? 0,
    volatilityFloorPct: cfg.fastVolatilityFloorPct ?? 0.05,
    volatilityCeilingPct: cfg.fastVolatilityCeilingPct ?? 0,
    trendMode: cfg.fastTrendMode === true || cfg.fastTrendMode === 1 || cfg.fastTrendMode === '1',
    trendSlopePct: cfg.fastTrendSlopePct ?? 0,
    trendSlopeWindowSeconds: cfg.fastTrendSlopeWindowSeconds ?? 0,
    regimeEmaPeriod: cfg.fastRegimeEmaPeriod ?? 0,
    regimeSlopeWindowSeconds: cfg.fastRegimeSlopeWindowSeconds ?? 0,
    regimeSlopeMinPct: cfg.fastRegimeSlopeMinPct ?? 0,
    volumeWindowSamples: cfg.fastVolumeWindowSeconds ?? 0,
    volumeMinRatio: cfg.fastVolumeMinRatio ?? 0,
    trailingVolatilityMult: cfg.fastTrailingVolatilityMult ?? 0,
    scaleOutPct: cfg.fastScaleOutPct ?? 0,
  }
}

export interface EntrySignal {
  shouldEnter: boolean
  reason: string | null
  momentumPct: number | null
  rsi: number | null
  ema: number | null
  volatilityPct: number | null
  /** Entry price levels (computed only when shouldEnter is true). */
  stopLoss: number | null
  takeProfit: number | null
  /** Effective (vol-scaled) SL distance in % — for risk-normalized sizing. */
  stopLossPct: number | null
}

export interface ExitPositionState {
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  takeProfit: number
  /** Highest price seen since entry (BUY) — trailing anchor. */
  peakPrice: number | null
  /** Epoch ms the position was opened. */
  openedAt: number
  /** Whether a scale-out partial exit already happened. */
  scaledOut: boolean
}

export interface ExitSignal {
  shouldExit: boolean
  reason: string | null
  /** Updated trailing stop to persist even while holding. */
  trailingStop: number | null
  /** Updated peak to persist. */
  peakPrice: number
  /** True once when the trailing stop first arms and scale-out is enabled. */
  scaleOut: boolean
}

export class FastStrategy {
  /**
   * Entry gate. `price` is the live/backtest price at decision time `now`.
   * Levels are computed from volatility-scaled percentages.
   */
  public evaluateEntry(
    feed: MomentumFeed,
    symbol: string,
    price: number,
    now: number,
    cfg: FastStrategyConfig
  ): EntrySignal {
    // Volume confirmation — skipped live (no per-tick volume) and while the
    // median window is warming up.
    if (cfg.volumeMinRatio > 0 && cfg.volumeWindowSamples > 0) {
      const last = feed.lastVolume(symbol)
      const median = feed.volumeMedian(symbol, cfg.volumeWindowSamples, now)
      if (last !== null && median !== null && median > 0 && last < median * cfg.volumeMinRatio) {
        return {
          shouldEnter: false,
          reason: `volume ${last.toFixed(0)} < median ${median.toFixed(0)} × ${cfg.volumeMinRatio}`,
          momentumPct: null, rsi: null, ema: null, volatilityPct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    // Trend-rider path: replaces the momentum+RSI gate. Only enters when
    // the trend is ESTABLISHED (price above EMA + EMA rising), never on
    // burst momentum — that's what makes it ride smooth rallies instead of
    // chasing their peaks.
    if (cfg.trendMode) {
      return this.evaluateTrendEntry(feed, symbol, price, now, cfg)
    }

    const score: MomentumScore = feed.score(symbol, {
      windowSeconds: cfg.momentumSeconds,
      thresholdPct: cfg.momentumThresholdPct,
      rsiLow: cfg.rsiLow,
      rsiHigh: cfg.rsiHigh,
      now,
    })

    if (!score.pass) {
      return {
        shouldEnter: false,
        reason: score.reason,
        momentumPct: score.momentumPct,
        rsi: score.rsi,
        ema: null,
        volatilityPct: null,
        stopLoss: null,
        takeProfit: null,
      }
    }

    // EMA trend filter — lenient while warming up (same pattern as RSI).
    let ema: number | null = null
    if (cfg.emaPeriod > 0) {
      ema = feed.ema(symbol, cfg.emaPeriod, now)
      if (ema !== null && price <= ema) {
        return {
          shouldEnter: false,
          reason: `price ${price.toFixed(2)} <= EMA-${cfg.emaPeriod} ${ema.toFixed(2)} (downtrend filter)`,
          momentumPct: score.momentumPct,
          rsi: score.rsi,
          ema,
          volatilityPct: null,
          stopLoss: null,
          takeProfit: null,
        }
      }
    }

    // Volatility ceiling — skip wild markets.
    let volatilityPct: number | null = null
    if (cfg.volatilityCeilingPct > 0 && cfg.volatilityWindowSamples > 0) {
      volatilityPct = feed.volatilityPct(symbol, cfg.volatilityWindowSamples, now)
      if (volatilityPct !== null && volatilityPct > cfg.volatilityCeilingPct) {
        return {
          shouldEnter: false,
          reason: `volatility ${volatilityPct.toFixed(3)}% > ceiling ${cfg.volatilityCeilingPct}%`,
          momentumPct: score.momentumPct,
          rsi: score.rsi,
          ema,
          volatilityPct,
          stopLoss: null,
          takeProfit: null,
        }
      }
    }

    const levels = this.entryLevels(feed, symbol, price, now, cfg, volatilityPct)
    return {
      shouldEnter: true,
      reason: score.reason,
      momentumPct: score.momentumPct,
      rsi: score.rsi,
      ema,
      volatilityPct,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      stopLossPct: levels.stopLossPct,
    }
  }

  private evaluateTrendEntry(
    feed: MomentumFeed,
    symbol: string,
    price: number,
    now: number,
    cfg: FastStrategyConfig
  ): EntrySignal {
    if (cfg.emaPeriod <= 0) {
      return {
        shouldEnter: false,
        reason: 'trend mode requires fastEmaPeriod > 0',
        momentumPct: null, rsi: null, ema: null, volatilityPct: null,
        stopLoss: null, takeProfit: null, stopLossPct: null,
      }
    }

    // Regime gate: the market must be trending on a SLOWER horizon, or we
    // stand aside entirely (flat markets = chop churn). Lenient while the
    // regime window warms up.
    if (cfg.regimeEmaPeriod > 0 && cfg.regimeSlopeWindowSeconds > 0) {
      const regimeSlope = feed.emaSlopePct(symbol, cfg.regimeEmaPeriod, cfg.regimeSlopeWindowSeconds, now)
      if (regimeSlope !== null && regimeSlope < cfg.regimeSlopeMinPct) {
        return {
          shouldEnter: false,
          reason: `regime: EMA-${cfg.regimeEmaPeriod} slope ${regimeSlope.toFixed(3)}% < ${cfg.regimeSlopeMinPct}% over ${cfg.regimeSlopeWindowSeconds}s (not trending)`,
          momentumPct: null, rsi: null, ema: null, volatilityPct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    const ema = feed.ema(symbol, cfg.emaPeriod, now)
    if (ema !== null && price <= ema) {
      return {
        shouldEnter: false,
        reason: `price ${price.toFixed(2)} <= EMA-${cfg.emaPeriod} ${ema.toFixed(2)} (no uptrend)`,
        momentumPct: null, rsi: null, ema, volatilityPct: null,
        stopLoss: null, takeProfit: null, stopLossPct: null,
      }
    }

    // EMA slope gate — lenient while the slope window is still warming.
    let slope: number | null = null
    if (cfg.trendSlopeWindowSeconds > 0) {
      slope = feed.emaSlopePct(symbol, cfg.emaPeriod, cfg.trendSlopeWindowSeconds, now)
      if (slope !== null && slope < cfg.trendSlopePct) {
        return {
          shouldEnter: false,
          reason: `EMA-${cfg.emaPeriod} slope ${slope.toFixed(3)}% < ${cfg.trendSlopePct}% over ${cfg.trendSlopeWindowSeconds}s`,
          momentumPct: null, rsi: null, ema, volatilityPct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    const levels = this.entryLevels(feed, symbol, price, now, cfg, null)
    return {
      shouldEnter: true,
      reason: slope === null
        ? `trend: price ${price.toFixed(2)} > EMA-${cfg.emaPeriod} (slope warming)`
        : `trend: price ${price.toFixed(2)} > EMA-${cfg.emaPeriod}, slope ${slope.toFixed(3)}%`,
      momentumPct: null,
      rsi: null,
      ema,
      volatilityPct: null,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      stopLossPct: levels.stopLossPct,
    }
  }

  /**
   * Entry stop/take-profit levels. Percentages are scaled up by volatility:
   * measured per-minute vol above the floor widens SL (and TP, preserving
   * the configured risk/reward ratio) so trades aren't stopped out by noise
   * in choppy conditions.
   */
  public entryLevels(
    feed: MomentumFeed,
    symbol: string,
    price: number,
    now: number,
    cfg: FastStrategyConfig,
    measuredVolPct: number | null
  ): { stopLoss: number; takeProfit: number; stopLossPct: number; takeProfitPct: number } {
    let stopLossPct = cfg.stopLossPct
    let takeProfitPct = cfg.takeProfitPct

    if (cfg.volatilityWindowSamples > 0 && cfg.volatilityMult > 0 && price > 0) {
      const volPct = measuredVolPct ?? feed.volatilityPct(symbol, cfg.volatilityWindowSamples, now)
      if (volPct !== null) {
        // Per-sample (≈per-second) vol → per-minute, floored.
        const minuteVol = Math.max(volPct * Math.sqrt(60), cfg.volatilityFloorPct)
        const scaled = cfg.volatilityMult * minuteVol
        if (scaled > cfg.stopLossPct) {
          const factor = scaled / cfg.stopLossPct
          stopLossPct = scaled
          takeProfitPct = cfg.takeProfitPct > 0 ? cfg.takeProfitPct * factor : 0
        }
      }
    }

    return {
      stopLoss: price * (1 - stopLossPct / 100),
      takeProfit: takeProfitPct > 0 ? price * (1 + takeProfitPct / 100) : 0,
      stopLossPct,
      takeProfitPct,
    }
  }

  /**
   * Exit evaluation. Pure: returns a decision + state updates to persist
   * (trailing stop ratchet + peak). The caller persists those.
   */
  public evaluateExit(
    feed: MomentumFeed,
    symbol: string,
    price: number,
    now: number,
    pos: ExitPositionState,
    cfg: FastStrategyConfig
  ): ExitSignal {
    const isBuy = pos.side === 'BUY'
    const gainPct = isBuy
      ? ((price - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - price) / pos.entryPrice) * 100

    const peak = pos.peakPrice === null || pos.peakPrice <= 0
      ? (isBuy ? Math.max(pos.entryPrice, price) : Math.min(pos.entryPrice, price))
      : isBuy
        ? Math.max(pos.peakPrice, price)
        : Math.min(pos.peakPrice, price)

    // Trailing stop: once profit clears the activation threshold, ratchet
    // the stop to stay `trailingStopPct` behind the peak. The distance can
    // scale with volatility (wider trail in high vol = don't get shaken out).
    let trailingStop: number | null = null
    let scaleOut = false
    if (cfg.trailingStopPct > 0 && cfg.trailingActivatePct > 0) {
      if (gainPct >= cfg.trailingActivatePct) {
        let trailPct = cfg.trailingStopPct
        if (cfg.trailingVolatilityMult > 0 && cfg.volatilityWindowSamples > 0) {
          const volPct = feed.volatilityPct(symbol, cfg.volatilityWindowSamples, now)
          if (volPct !== null) {
            const minuteVol = Math.max(volPct * Math.sqrt(60), cfg.volatilityFloorPct)
            trailPct = Math.max(trailPct, cfg.trailingVolatilityMult * minuteVol)
          }
        }
        trailingStop = isBuy
          ? peak * (1 - trailPct / 100)
          : peak * (1 + trailPct / 100)
        // Never loosen a tightened stop.
        if (isBuy) trailingStop = Math.max(trailingStop, pos.stopLoss)
        else trailingStop = Math.min(trailingStop, pos.stopLoss)

        // Scale-out fires exactly once, when the trail first arms.
        if (cfg.scaleOutPct > 0 && !pos.scaledOut) {
          scaleOut = true
        }
      }
    }

    // Priority order: SL/TP → trailing → max hold → reversal.
    if (isBuy && price <= pos.stopLoss) {
      return { shouldExit: true, reason: `stop-loss: ${price.toFixed(2)} <= ${pos.stopLoss.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false }
    }
    if (!isBuy && price >= pos.stopLoss) {
      return { shouldExit: true, reason: `stop-loss: ${price.toFixed(2)} >= ${pos.stopLoss.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false }
    }
    // takeProfit <= 0 = no take profit (trend mode rides the trailing stop).
    if (pos.takeProfit > 0 && isBuy && price >= pos.takeProfit) {
      return { shouldExit: true, reason: `take-profit: ${price.toFixed(2)} >= ${pos.takeProfit.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false }
    }
    if (pos.takeProfit > 0 && !isBuy && price <= pos.takeProfit) {
      return { shouldExit: true, reason: `take-profit: ${price.toFixed(2)} <= ${pos.takeProfit.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false }
    }
    if (trailingStop !== null && isBuy && price <= trailingStop) {
      return { shouldExit: true, reason: `trailing stop: ${price.toFixed(2)} <= ${trailingStop.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false }
    }
    if (trailingStop !== null && !isBuy && price >= trailingStop) {
      return { shouldExit: true, reason: `trailing stop: ${price.toFixed(2)} >= ${trailingStop.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false }
    }

    if (cfg.maxHoldSeconds > 0 && now - pos.openedAt > cfg.maxHoldSeconds * 1000) {
      const held = Math.round((now - pos.openedAt) / 1000)
      return { shouldExit: true, reason: `max hold: ${held}s >= ${cfg.maxHoldSeconds}s`, trailingStop, peakPrice: peak, scaleOut: false }
    }

    const mom = feed.momentumPct(symbol, cfg.momentumSeconds, now)
    if (mom !== null && mom <= cfg.exitReversalPct) {
      return { shouldExit: true, reason: `momentum reversal: ${mom.toFixed(3)}% <= ${cfg.exitReversalPct}%`, trailingStop, peakPrice: peak, scaleOut: false }
    }

    return { shouldExit: false, reason: null, trailingStop, peakPrice: peak, scaleOut }
  }
}

export default new FastStrategy()
