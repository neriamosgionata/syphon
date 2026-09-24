// ─── Pure intraminute strategy core ───────────────────────────
//
// Deterministic, I/O-free entry/exit decision logic for the fast algo.
// No DB, no WS, no engine, no env — everything comes in through the
// function arguments. The live loop (FastAlgoService) and the backtester
// (BacktestEngine) both call this, so live behaviour and backtest
// behaviour are the same code path.
//
// Entry gates (all must pass):
//   1. session gate      (optional UTC hour window — time-of-day seasonality)
//   2. choppiness gate   (optional CHOP <= max — skip ranging markets)
//   3. momentum + RSI   (MomentumFeed.score — momentum over window,
//                        Wilder RSI-7 within [rsiLow, rsiHigh])
//   4. EMA trend filter (price above EMA when emaPeriod > 0; lenient
//                        while the EMA is still warming up)
//   5. volatility ceiling (skip when measured vol exceeds the ceiling)
//   6. Jev veto (optional advisory overlay — blocks a warm entry only on a
//                confident-negative read with edge; null/low-conf never blocks)
//
// Exit rules (checked in priority order):
//   1. stop loss        (fixed price level; ratcheted by trailing stop)
//   2. take profit      (fixed price level)
//   3. trailing stop    (arms once profit >= activatePct, trails
//                        trailingStopPct behind the peak)
//   4. CUSUM trend break (cumulative price-vs-EMA deviation exits early
//                        on regime change — changepoint-detection analog)
//   5. max hold         (force-close after maxHoldSeconds)
//   6. momentum reversal (momentum drops to/below exitReversalPct)
//
// Jev exit reads are annotation-only (jevAdvisory on every outcome) and
// never enter the priority chain above.

import { MomentumFeed, MomentumScore } from '#services/MomentumFeed'

const SECONDS_PER_YEAR = 31_536_000

/**
 * Volatility-targeting multiplier (Moreira-Muir): scale exposure so the
 * portfolio's realized vol matches a target. `perSampleVolPct` is the
 * stddev of per-sample returns in % — annualized with sqrt(seconds per
 * year / samples per second), i.e. cadence-corrected (1s samples use the
 * full year; 60s samples annualize with sqrt of minutes per year).
 * Clamped to [0.2, maxMult]. 1.0 when vol is unmeasurable.
 */
export function volatilityMultiplier(
  perSampleVolPct: number | null,
  targetAnnPct: number,
  maxMult = 2,
  sampleIntervalSeconds = 1
): number {
  if (perSampleVolPct === null || perSampleVolPct <= 0 || !Number.isFinite(perSampleVolPct)) return 1
  if (targetAnnPct <= 0) return 1
  const interval = Math.min(Math.max(sampleIntervalSeconds || 1, 1), 3600)
  const annualized = perSampleVolPct * Math.sqrt(SECONDS_PER_YEAR / interval)
  if (annualized <= 0 || !Number.isFinite(annualized)) return 1
  return Math.min(Math.max(maxMult, 0), Math.max(0.2, targetAnnPct / annualized))
}

export interface FastStrategyConfig {
  /**
   * Seconds between feed samples the strategy was built for: 1 on the live
   * 1s loop, 60 for 1m-bar backtests. Sample-count lookbacks are expressed
   * per-sample, so this keeps time semantics identical across cadences.
   */
  sampleIntervalSeconds?: number
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
  /**
   * Use the HAR multi-horizon volatility forecast (Corsi 2009; BTC-validated
   * by Hu, Härdle & Kuo 2021) instead of a single-window stddev for SL/TP
   * scaling, trailing width, the vol ceiling and vol targeting.
   */
  harVolForecast: boolean
  /** CUSUM trend-break exit: window (s) over which price-vs-EMA deviations accumulate. 0 = off. */
  cusumWindowSeconds: number
  /** Exit a BUY (SELL) when cumulative (ema-price)/ema over the window >= (+/-) this %. 0 = off. */
  cusumExitPct: number
  /**
   * Jump-aware SL slack: when a single-sample down move >= this % occurred in
   * the vol window, widen the stop by (1 + slack/100). Negative jumps raise
   * near-term risk (Hu et al. 2021). 0 = off.
   */
  jumpSlackPct: number
  /** Choppiness gate: entry requires CHOP <= choppinessMax over this many samples. 0 = off. */
  choppinessPeriod: number
  /** Max close-based Choppiness Index to allow an entry (low = trending). 0 = off. */
  choppinessMax: number
  /** UTC hour when trading may start (0-23). Gate off when endUtc <= startUtc. */
  tradeStartUtc: number
  /** UTC hour when trading stops (1-24; 24 = end of day). Gate off when endUtc <= startUtc. */
  tradeEndUtc: number
  /**
   * Kaufman efficiency-ratio entry gate (0 = off): skip entries unless the
   * market was directional over the last `efficiencyWindowDays` days — the
   * |net move| / path-length ratio must be >= efficiencyMinPct (in %,
   * e.g. 30 = 0.30). A trending market has ER ~40-70, chop ~5-20. Directly
   * blocks "buy the rally pop inside a chop year" whipsaw entries.
   */
  efficiencyWindowDays?: number
  efficiencyMinPct?: number
  /**
   * Efficiency-collapse exit (0 = off): while a position is held WITHOUT an
   * armed trailing stop, exit if the efficiency ratio over
   * `efficiencyWindowDays` drops below this % — the directional regime that
   * justified the entry is gone and the open position is now chop-exposed.
   * Trail-armed winners are left alone (the stop already protects them).
   */
  efficiencyExitPct?: number
  /** Scale position size with signal strength (slope/momentum vs threshold). 0 = off. */
  convictionSizing: boolean
  /**
   * News-sentiment entry gate (0 = off): block entries while the
   * recency-weighted news sentiment for the symbol sits below
   * `newsMinSentiment` AND at least `newsMinArticles` distinct events
   * occurred in the window. The score itself is computed OUTSIDE the
   * strategy (live: NewsSentimentService; backtest: replayed historical
   * tone) and passed in — the strategy stays pure and replayable.
   * No news in the window (events < newsMinArticles) never blocks.
   */
  newsGateEnabled: boolean
  /** Minimum recency-weighted news sentiment to allow an entry. */
  newsMinSentiment: number
  /** Distinct news events required before the gate can block. */
  newsMinArticles: number
  /** News lookback window in seconds (same on both sides of parity). */
  newsWindowSeconds: number
  /**
   * Jev advisory overlay (U2): veto entries on confident-negative reads.
   * Optional so existing config literals keep compiling; absent = off.
   * The context itself is computed OUTSIDE the strategy (live:
   * JevDecisionService; backtest: recorded scores) and passed in — the
   * strategy stays pure and replayable. Null/low-confidence never blocks.
   */
  jevGateEnabled?: boolean
  /** Minimum combined Jev confidence to act on a read. */
  jevMinConfidence?: number
  /** Minimum (pDown - pUp) edge to veto an entry. */
  jevMinEdgePct?: number
}

/**
 * Structural mapping from a persisted config row (AlgoConfig or a plain
 * object with the same field names) onto the strategy config. A value of
 * 0/null disables the corresponding control.
 *
 * `opts.sampleIntervalSeconds` (default 1) rescales the SAMPLE-COUNT
 * lookbacks (EMA periods, volatility/volume/choppiness windows) so their
 * wall-clock meaning is preserved on coarser bars: at 60s/bar an EMA-900s
 * period becomes 15 samples, a 3600s vol window 60 samples, etc. True-time
 * windows (momentum, CUSUM, slope windows, max hold) are cadence-free and
 * pass through unchanged.
 */
export function fastStrategyFromConfig(
  cfg: {
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
    fastHarVolForecast?: boolean | number | null
    fastCusumWindowSeconds?: number | null
    fastCusumExitPct?: number | null
    fastJumpSlackPct?: number | null
    fastChoppinessPeriod?: number | null
    fastChoppinessMax?: number | null
    fastTradeStartUtc?: number | null
    fastTradeEndUtc?: number | null
    fastEfficiencyWindowDays?: number | null
    fastEfficiencyMinPct?: number | null
    fastEfficiencyExitPct?: number | null
    fastConvictionSizing?: boolean | number | null
    fastNewsGateEnabled?: boolean | number | null
    fastNewsMinSentiment?: number | null
    fastNewsMinArticles?: number | null
    fastNewsWindowHours?: number | null
    fastJevGateEnabled?: boolean | number | null
    fastJevMinConfidence?: number | null
    fastJevMinEdgePct?: number | null
  },
  opts?: { sampleIntervalSeconds?: number }
): FastStrategyConfig {
  const sampleInterval = Math.min(Math.max(opts?.sampleIntervalSeconds || 1, 1), 3600)
  const samples = (seconds: number | null | undefined): number => {
    if (!seconds || seconds <= 0) return 0
    return Math.max(1, Math.round(seconds / sampleInterval))
  }
  return {
    sampleIntervalSeconds: sampleInterval,
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
    emaPeriod: samples(cfg.fastEmaPeriod),
    volatilityWindowSamples: samples(cfg.fastVolatilityWindowSeconds),
    volatilityMult: cfg.fastVolatilityMult ?? 0,
    volatilityFloorPct: cfg.fastVolatilityFloorPct ?? 0.05,
    volatilityCeilingPct: cfg.fastVolatilityCeilingPct ?? 0,
    trendMode: cfg.fastTrendMode === true || cfg.fastTrendMode === 1 || cfg.fastTrendMode === '1',
    trendSlopePct: cfg.fastTrendSlopePct ?? 0,
    trendSlopeWindowSeconds: cfg.fastTrendSlopeWindowSeconds ?? 0,
    regimeEmaPeriod: samples(cfg.fastRegimeEmaPeriod),
    regimeSlopeWindowSeconds: cfg.fastRegimeSlopeWindowSeconds ?? 0,
    regimeSlopeMinPct: cfg.fastRegimeSlopeMinPct ?? 0,
    volumeWindowSamples: samples(cfg.fastVolumeWindowSeconds),
    volumeMinRatio: cfg.fastVolumeMinRatio ?? 0,
    trailingVolatilityMult: cfg.fastTrailingVolatilityMult ?? 0,
    scaleOutPct: cfg.fastScaleOutPct ?? 0,
    harVolForecast: cfg.fastHarVolForecast === true || cfg.fastHarVolForecast === 1,
    cusumWindowSeconds: cfg.fastCusumWindowSeconds ?? 0,
    cusumExitPct: cfg.fastCusumExitPct ?? 0,
    jumpSlackPct: cfg.fastJumpSlackPct ?? 0,
    choppinessPeriod: samples(cfg.fastChoppinessPeriod),
    choppinessMax: cfg.fastChoppinessMax ?? 0,
    tradeStartUtc: cfg.fastTradeStartUtc ?? 0,
    tradeEndUtc: cfg.fastTradeEndUtc ?? 24,
    efficiencyWindowDays: cfg.fastEfficiencyWindowDays ?? 0,
    efficiencyMinPct: cfg.fastEfficiencyMinPct ?? 0,
    efficiencyExitPct: cfg.fastEfficiencyExitPct ?? 0,
    convictionSizing: cfg.fastConvictionSizing === true || cfg.fastConvictionSizing === 1,
    newsGateEnabled: cfg.fastNewsGateEnabled === true || cfg.fastNewsGateEnabled === 1,
    newsMinSentiment: cfg.fastNewsMinSentiment ?? 0,
    newsMinArticles: cfg.fastNewsMinArticles ?? 3,
    newsWindowSeconds: Math.max(1, (cfg.fastNewsWindowHours ?? 24) * 3600),
    jevGateEnabled: cfg.fastJevGateEnabled === true || cfg.fastJevGateEnabled === 1,
    jevMinConfidence: cfg.fastJevMinConfidence ?? 0.5,
    jevMinEdgePct: cfg.fastJevMinEdgePct ?? 0.15,
  }
}

export interface EntrySignal {
  shouldEnter: boolean
  reason: string | null
  momentumPct: number | null
  rsi: number | null
  ema: number | null
  volatilityPct: number | null
  /** Trend-mode EMA slope % over the slope window (null in burst mode / warming). */
  slopePct: number | null
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
  /**
   * Jev exit advisory (U2): logged context only, never changes shouldExit.
   * Null when the overlay is off, the read is missing/low-confidence, or no
   * context was passed — exits stay fully deterministic either way.
   */
  jevAdvisory?: string | null
}

/**
 * News context computed OUTSIDE the strategy (live: NewsSentimentService;
 * backtest: replayed historical events) and passed into the entry gate.
 * Null = no news signal available — never blocks.
 */
export interface NewsContext {
  /** Recency-weighted sentiment in [-1, 1]. Null when no news in window. */
  score: number | null
  /** Distinct news events in the window. */
  events: number
}

/**
 * Jev advisory context computed OUTSIDE the strategy (live:
 * JevDecisionService; backtest: recorded scores) and passed into the entry
 * gate and exit annotator. Mirrors the NewsContext optional-null fail-open
 * shape: a missing or low-confidence read never changes an outcome.
 * Deliberately decoupled from the service types — the core stays import-free.
 */
export interface JevContext {
  /** Calibrated P(up move). Null = no signal. */
  pUp: number | null
  /** Calibrated P(down move). Null = no signal. */
  pDown: number | null
  /** Combined (min) Choice/Score confidence. Null = no signal. */
  confidence: number | null
  /** Served from the staleness-reuse window rather than a fresh call. */
  stale?: boolean
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
    cfg: FastStrategyConfig,
    news?: NewsContext | null,
    jev?: JevContext | null
  ): EntrySignal {
    // Session gate: only trade during the configured UTC hours (crypto
    // vol/volume follow time-of-day seasonality — Saef et al. 2021,
    // Petukhina et al. 2020). Off when endUtc <= startUtc.
    const utcHour = new Date(now).getUTCHours()
    if (cfg.tradeEndUtc > cfg.tradeStartUtc && (utcHour < cfg.tradeStartUtc || utcHour >= cfg.tradeEndUtc)) {
      return {
        shouldEnter: false,
        reason: `session: UTC ${utcHour}h outside [${cfg.tradeStartUtc}, ${cfg.tradeEndUtc})`,
        momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
        stopLoss: null, takeProfit: null, stopLossPct: null,
      }
    }

    // News-sentiment gate: stand aside while the news flow for the symbol
    // is clearly negative. Only blocks when there IS enough news to judge
    // (events >= newsMinArticles) — a quiet news day never blocks entries.
    // Null news context (infra failure, no signal) also never blocks.
    if (
      cfg.newsGateEnabled &&
      news &&
      news.score !== null &&
      news.events >= cfg.newsMinArticles &&
      news.score < cfg.newsMinSentiment
    ) {
      return {
        shouldEnter: false,
        reason: `news sentiment ${news.score.toFixed(3)} < ${cfg.newsMinSentiment.toFixed(3)} (${news.events} events)`,
        momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
        stopLoss: null, takeProfit: null, stopLossPct: null,
      }
    }

    // Efficiency-ratio gate: only enter when recent price action was
    // directional, not a random-walk chop (Kaufman 1995). Lenient while the
    // daily grid is warming up.
    if (cfg.efficiencyWindowDays > 0 && cfg.efficiencyMinPct > 0) {
      const er = feed.efficiencyRatioPct(symbol, cfg.efficiencyWindowDays, now)
      if (er !== null && er < cfg.efficiencyMinPct) {
        return {
          shouldEnter: false,
          reason: `efficiency ${er.toFixed(1)} < ${cfg.efficiencyMinPct} over ${cfg.efficiencyWindowDays}d (chop)`,
          momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    // Choppiness gate: stand aside while the market is ranging (high CHOP).
    if (cfg.choppinessPeriod > 0 && cfg.choppinessMax > 0) {
      const chop = feed.choppiness(symbol, cfg.choppinessPeriod, now)
      if (chop !== null && chop > cfg.choppinessMax) {
        return {
          shouldEnter: false,
          reason: `choppiness ${chop.toFixed(1)} > ${cfg.choppinessMax} (ranging)`,
          momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    // Volume confirmation — skipped live (no per-tick volume) and while the
    // median window is warming up.
    if (cfg.volumeMinRatio > 0 && cfg.volumeWindowSamples > 0) {
      const last = feed.lastVolume(symbol)
      const median = feed.volumeMedian(symbol, cfg.volumeWindowSamples, now)
      if (last !== null && median !== null && median > 0 && last < median * cfg.volumeMinRatio) {
        return {
          shouldEnter: false,
          reason: `volume ${last.toFixed(0)} < median ${median.toFixed(0)} × ${cfg.volumeMinRatio}`,
          momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    // Trend-rider path: replaces the momentum+RSI gate. Only enters when
    // the trend is ESTABLISHED (price above EMA + EMA rising), never on
    // burst momentum — that's what makes it ride smooth rallies instead of
    // chasing their peaks.
    if (cfg.trendMode) {
      return this.evaluateTrendEntry(feed, symbol, price, now, cfg, jev)
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
        slopePct: null,
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
      volatilityPct = this.measuredVolPct(feed, symbol, cfg.volatilityWindowSamples, now, cfg)
      if (volatilityPct !== null && volatilityPct > cfg.volatilityCeilingPct) {
        return {
          shouldEnter: false,
          reason: `volatility ${volatilityPct.toFixed(3)}% > ceiling ${cfg.volatilityCeilingPct}%`,
          momentumPct: score.momentumPct,
          rsi: score.rsi,
          ema,
          volatilityPct,
          slopePct: null,
          stopLoss: null,
          takeProfit: null,
        }
      }
    }

    const levels = this.entryLevels(feed, symbol, price, now, cfg, volatilityPct)
    const veto = this.jevVetoReason(jev, cfg)
    if (veto) {
      return {
        shouldEnter: false,
        reason: veto,
        momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
        stopLoss: null, takeProfit: null, stopLossPct: null,
      }
    }
    return {
      shouldEnter: true,
      reason: score.reason,
      momentumPct: score.momentumPct,
      rsi: score.rsi,
      ema,
      volatilityPct,
      slopePct: null,
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
    cfg: FastStrategyConfig,
    jev?: JevContext | null
  ): EntrySignal {
    if (cfg.emaPeriod <= 0) {
      return {
        shouldEnter: false,
        reason: 'trend mode requires fastEmaPeriod > 0',
        momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
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
          momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    const ema = feed.ema(symbol, cfg.emaPeriod, now)
    if (ema !== null && price <= ema) {
      return {
        shouldEnter: false,
        reason: `price ${price.toFixed(2)} <= EMA-${cfg.emaPeriod} ${ema.toFixed(2)} (no uptrend)`,
        momentumPct: null, rsi: null, ema, volatilityPct: null, slopePct: null,
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
          momentumPct: null, rsi: null, ema, volatilityPct: null, slopePct: null,
          stopLoss: null, takeProfit: null, stopLossPct: null,
        }
      }
    }

    const levels = this.entryLevels(feed, symbol, price, now, cfg, null)
    const veto = this.jevVetoReason(jev, cfg)
    if (veto) {
      return {
        shouldEnter: false,
        reason: veto,
        momentumPct: null, rsi: null, ema: null, volatilityPct: null, slopePct: null,
        stopLoss: null, takeProfit: null, stopLossPct: null,
      }
    }
    return {
      shouldEnter: true,
      reason: slope === null
        ? `trend: price ${price.toFixed(2)} > EMA-${cfg.emaPeriod} (slope warming)`
        : `trend: price ${price.toFixed(2)} > EMA-${cfg.emaPeriod}, slope ${slope.toFixed(3)}%`,
      momentumPct: null,
      rsi: null,
      ema,
      volatilityPct: null,
      slopePct: slope,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      stopLossPct: levels.stopLossPct,
    }
  }

  /**
   * Volatility estimate honoring the HAR-forecast flag: single-window stddev
   * by default, multi-horizon HAR blend (Corsi 2009) when enabled. HAR
   * windows scale as 1×/10×/60× the configured window (1m/10m/1h at the
   * default 60s window).
   */
  private measuredVolPct(
    feed: MomentumFeed,
    symbol: string,
    windowSamples: number,
    now: number,
    cfg: FastStrategyConfig
  ): number | null {
    if (cfg.harVolForecast && windowSamples > 0) {
      return feed.harVolatilityPct(symbol, windowSamples, windowSamples * 10, windowSamples * 60, now)
    }
    return feed.volatilityPct(symbol, windowSamples, now)
  }

  /**
   * Per-sample vol → per-minute vol. Per-minute σ = per-sample σ × √(60 /
   * interval): at 1s samples that's ×√60; a 60s bar already IS a minute
   * (×1). Keeps vol-scaled stops/trails time-consistent across cadences.
   */
  private perMinuteVolPct(sampleVolPct: number, cfg: FastStrategyConfig): number {
    const interval = Math.min(Math.max(cfg.sampleIntervalSeconds || 1, 1), 60)
    return sampleVolPct * Math.sqrt(60 / interval)
  }

  /**
   * Entry stop/take-profit levels. Percentages are scaled up by volatility:
   * measured per-minute vol above the floor widens SL (and TP, preserving
   * the configured risk/reward ratio) so trades aren't stopped out by noise
   * in choppy conditions. A recent downward jump widens the SL further
   * (negative jumps raise near-term risk — Hu, Härdle & Kuo 2021).
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
      const volPct = measuredVolPct ?? this.measuredVolPct(feed, symbol, cfg.volatilityWindowSamples, now, cfg)
      if (volPct !== null) {
        const minuteVol = Math.max(this.perMinuteVolPct(volPct, cfg), cfg.volatilityFloorPct)
        const scaled = cfg.volatilityMult * minuteVol
        if (scaled > cfg.stopLossPct) {
          const factor = scaled / cfg.stopLossPct
          stopLossPct = scaled
          takeProfitPct = cfg.takeProfitPct > 0 ? cfg.takeProfitPct * factor : 0
        }
      }
    }

    // Jump-aware SL: a recent single-sample down move >= jumpSlackPct means
    // elevated near-term downside — widen the stop (TP unchanged).
    if (cfg.jumpSlackPct > 0 && cfg.volatilityWindowSamples > 0) {
      const worst = feed.maxDownMovePct(symbol, cfg.volatilityWindowSamples, now)
      if (worst !== null && worst <= -cfg.jumpSlackPct) {
        stopLossPct *= 1 + cfg.jumpSlackPct / 100
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
    cfg: FastStrategyConfig,
    jev?: JevContext | null
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

    // Jev advisory annotation (U2): attached to every outcome below, never
    // consulted by the priority chain above or below this line.
    const jevAdvisory = this.jevExitNote(jev, cfg, isBuy)

    // Trailing stop: once profit clears the activation threshold, ratchet
    // the stop to stay `trailingStopPct` behind the peak. The distance can
    // scale with volatility (wider trail in high vol = don't get shaken out).
    let trailingStop: number | null = null
    let scaleOut = false
    if (cfg.trailingStopPct > 0 && cfg.trailingActivatePct > 0) {
      if (gainPct >= cfg.trailingActivatePct) {
        let trailPct = cfg.trailingStopPct
        if (cfg.trailingVolatilityMult > 0 && cfg.volatilityWindowSamples > 0) {
          const volPct = this.measuredVolPct(feed, symbol, cfg.volatilityWindowSamples, now, cfg)
          if (volPct !== null) {
            const minuteVol = Math.max(this.perMinuteVolPct(volPct, cfg), cfg.volatilityFloorPct)
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
      return { shouldExit: true, reason: `stop-loss: ${price.toFixed(2)} <= ${pos.stopLoss.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }
    if (!isBuy && price >= pos.stopLoss) {
      return { shouldExit: true, reason: `stop-loss: ${price.toFixed(2)} >= ${pos.stopLoss.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }
    // takeProfit <= 0 = no take profit (trend mode rides the trailing stop).
    if (pos.takeProfit > 0 && isBuy && price >= pos.takeProfit) {
      return { shouldExit: true, reason: `take-profit: ${price.toFixed(2)} >= ${pos.takeProfit.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }
    if (pos.takeProfit > 0 && !isBuy && price <= pos.takeProfit) {
      return { shouldExit: true, reason: `take-profit: ${price.toFixed(2)} <= ${pos.takeProfit.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }
    if (trailingStop !== null && isBuy && price <= trailingStop) {
      return { shouldExit: true, reason: `trailing stop: ${price.toFixed(2)} <= ${trailingStop.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }
    if (trailingStop !== null && !isBuy && price >= trailingStop) {
      return { shouldExit: true, reason: `trailing stop: ${price.toFixed(2)} >= ${trailingStop.toFixed(2)}`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }

    // Efficiency-collapse cut: entry regime gone while the trail is still
    // unarmed → don't sit through chop waiting for the stop. Trail-armed
    // winners are exempt (their stop already ratchets).
    if (cfg.efficiencyExitPct && cfg.efficiencyExitPct > 0 && cfg.efficiencyWindowDays && cfg.efficiencyWindowDays > 0 && trailingStop === null) {
      const er = feed.efficiencyRatioPct(symbol, cfg.efficiencyWindowDays, now)
      if (er !== null && er < cfg.efficiencyExitPct) {
        return {
          shouldExit: true,
          reason: `efficiency collapse: ${er.toFixed(1)} < ${cfg.efficiencyExitPct} over ${cfg.efficiencyWindowDays}d`,
          trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory,
        }
      }
    }

    // CUSUM trend-break exit (changepoint-detection analog — Wood, Roberts &
    // Zohren 2021): when price spent the window below (above) its EMA, the
    // trend bet is wrong — cut it instead of waiting for a slow EMA cross.
    if (cfg.cusumExitPct > 0 && cfg.cusumWindowSeconds > 0 && cfg.emaPeriod > 0) {
      const cusum = feed.cusumDeviationPct(symbol, cfg.emaPeriod, cfg.cusumWindowSeconds, now)
      if (cusum !== null && (isBuy ? cusum >= cfg.cusumExitPct : cusum <= -cfg.cusumExitPct)) {
        return {
          shouldExit: true,
          reason: `cusum trend break: ${cusum.toFixed(3)}% ${isBuy ? '>=' : '<='} ${isBuy ? '+' : '-'}${cfg.cusumExitPct}%`,
          trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory,
        }
      }
    }

    if (cfg.maxHoldSeconds > 0 && now - pos.openedAt > cfg.maxHoldSeconds * 1000) {
      const held = Math.round((now - pos.openedAt) / 1000)
      return { shouldExit: true, reason: `max hold: ${held}s >= ${cfg.maxHoldSeconds}s`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }

    const mom = feed.momentumPct(symbol, cfg.momentumSeconds, now)
    if (mom !== null && mom <= cfg.exitReversalPct) {
      return { shouldExit: true, reason: `momentum reversal: ${mom.toFixed(3)}% <= ${cfg.exitReversalPct}%`, trailingStop, peakPrice: peak, scaleOut: false, jevAdvisory }
    }

    return { shouldExit: false, reason: null, trailingStop, peakPrice: peak, scaleOut, jevAdvisory }
  }

  /**
   * Jev entry veto (U2): blocks a warm deterministic entry only on a
   * confident-negative read with enough edge. Null, low-confidence, thin
   * edge, or a disabled gate returns null — the entry stands. Pure.
   */
  private jevVetoReason(jev: JevContext | null | undefined, cfg: FastStrategyConfig): string | null {
    if (!cfg.jevGateEnabled) return null
    if (!jev || jev.pUp == null || jev.pDown == null || jev.confidence == null) return null
    const minConf = cfg.jevMinConfidence ?? 0.5
    const minEdge = cfg.jevMinEdgePct ?? 0.15
    if (jev.confidence < minConf) return null
    const edge = jev.pDown - jev.pUp
    if (edge < minEdge) return null
    const stale = jev.stale ? ' stale' : ''
    return `jev veto${stale}: pDown ${jev.pDown.toFixed(2)} vs pUp ${jev.pUp.toFixed(2)} (edge ${edge.toFixed(2)} >= ${minEdge}, conf ${jev.confidence.toFixed(2)})`
  }

  /**
   * Jev exit advisory note (U2): describes the read adverse to the held
   * side for logging only. Never influences shouldExit — callers attach it
   * to every exit/hold outcome. Null when there is nothing worth logging.
   */
  private jevExitNote(jev: JevContext | null | undefined, cfg: FastStrategyConfig, isBuy: boolean): string | null {
    if (!cfg.jevGateEnabled) return null
    if (!jev || jev.pUp == null || jev.pDown == null || jev.confidence == null) return null
    const minConf = cfg.jevMinConfidence ?? 0.5
    if (jev.confidence < minConf) return null
    const adverse = isBuy ? jev.pDown : jev.pUp
    const stale = jev.stale ? ' stale' : ''
    return `jev advisory${stale}: adverse p=${adverse.toFixed(2)} conf=${jev.confidence.toFixed(2)} (logged only)`
  }

  /**
   * Jev exit advisory for held positions (exit-first path): same note as
   * evaluateExit attaches, without re-running the exit chain. Pure.
   */
  public jevExitAdvisory(
    jev: JevContext | null | undefined,
    cfg: FastStrategyConfig,
    side: string
  ): string | null {
    return this.jevExitNote(jev, cfg, side === 'BUY')
  }

  /**
   * Jev conviction sizing (U2): shrink-only map from confidence to a
   * [0.5, 1.0] multiplier — full size at confidence 1, half size at the
   * floor, 1 (no scaling) when the overlay is off or the read is unusable.
   * The floor is fitted jointly with its gate threshold (U5); it never
   * grows a position above its deterministic size.
   */
  public jevConvictionMultiplier(jev: JevContext | null | undefined, cfg: FastStrategyConfig): number {
    if (!cfg.jevGateEnabled) return 1
    if (!jev || jev.confidence == null) return 1
    const min = cfg.jevMinConfidence ?? 0.5
    if (jev.confidence < min || min >= 1) return 1
    return 0.5 + 0.5 * ((jev.confidence - min) / (1 - min))
  }

  /**
   * Conviction-scaled position sizing (deterministic mirror of the learned
   * position-sizing layer of Deep Momentum Networks, Lim et al. 2019): the
   * stronger the signal vs its threshold, the larger the size — bounded
   * [0.5, 1.5]. Returns 1 when disabled or the signal is unmeasurable.
   */
  public convictionMultiplier(signal: EntrySignal, cfg: FastStrategyConfig): number {
    if (!cfg.convictionSizing) return 1
    const base = cfg.trendMode ? signal.slopePct : signal.momentumPct
    const threshold = cfg.trendMode ? cfg.trendSlopePct : cfg.momentumThresholdPct
    if (base === null || threshold <= 0) return 1
    const ratio = base / threshold
    return Math.min(1.5, Math.max(0.5, 0.5 + 0.5 * (ratio / 2)))
  }
}

export default new FastStrategy()
