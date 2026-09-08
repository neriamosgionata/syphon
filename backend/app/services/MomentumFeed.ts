// ─── Intraminute momentum feed ────────────────────────────────
//
// Pure in-memory rolling price series fed from the live Kraken WS cache.
// No DB, no env, no external deps — unit-testable in isolation.

export interface MomentumSample {
  t: number
  p: number
  /** Optional per-sample volume. Null/absent live. */
  v?: number
}

export interface MomentumScore {
  pass: boolean
  reason: string
  momentumPct: number | null
  rsi: number | null
}

/**
 * Wilder's RSI over a series of closes.
 * `period` = lookback periods (e.g. 7); the first `period` values are
 * consumed as the seed average gain/loss, so at least `period + 1` closes
 * are required.
 */
export function wildersRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) avgGain += diff
    else avgLoss -= diff
  }
  avgGain /= period
  avgLoss /= period

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff >= 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0 && avgGain === 0) return 50
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/**
 * Bucket raw samples into fixed-size close buckets (last sample per bucket),
 * oldest-first. Used to de-noise sub-second ticks before RSI.
 */
export function binCloses(samples: MomentumSample[], binSeconds: number, now: number): number[] {
  if (samples.length === 0) return []
  const closes: number[] = []
  let currentBin = -1
  for (const s of samples) {
    const bin = Math.floor((now - s.t) / 1000 / binSeconds)
    if (bin !== currentBin) {
      currentBin = bin
      closes.push(s.p)
    } else if (closes.length > 0) {
      closes[closes.length - 1] = s.p
    }
  }
  return closes
}

export class MomentumFeed {
  private series = new Map<string, MomentumSample[]>()
  private maxSamples = 14400 // 4 hours at 1s sampling (trend mode needs long windows)

  /**
   * Resize the per-symbol sample buffer. The backtester trims the buffer to
   * the longest indicator lookback so coarse-interval (1m) multi-year runs
   * don't rescan huge arrays on every decision tick. Live default (14400)
   * is left untouched.
   */
  public setMaxSamples(max: number): void {
    this.maxSamples = Math.min(Math.max(Math.round(max), 24), 200_000)
    for (const [symbol, arr] of this.series) {
      if (arr.length > this.maxSamples) arr.splice(0, arr.length - this.maxSamples)
    }
  }

  public push(symbol: string, price: number, t: number = Date.now(), volume?: number): void {
    if (!Number.isFinite(price) || price <= 0) return
    let arr = this.series.get(symbol)
    if (!arr) {
      arr = []
      this.series.set(symbol, arr)
    }
    arr.push({ t, p: price, v: volume })
    if (arr.length > this.maxSamples) arr.splice(0, arr.length - this.maxSamples)
  }

  public clear(symbol: string): void {
    this.series.delete(symbol)
  }

  public clearAll(): void {
    this.series.clear()
  }

  public sampleCount(symbol: string): number {
    return this.series.get(symbol)?.length || 0
  }

  public lastPrice(symbol: string): number | null {
    const arr = this.series.get(symbol)
    return arr && arr.length > 0 ? arr[arr.length - 1].p : null
  }

  /** Volume of the latest sample, or null when the sample has none. */
  public lastVolume(symbol: string): number | null {
    const arr = this.series.get(symbol)
    const last = arr && arr.length > 0 ? arr[arr.length - 1] : null
    return last && last.v !== undefined ? last.v : null
  }

  /** Median volume over the last `windowSamples`, or null when data is thin. */
  public volumeMedian(symbol: string, windowSamples: number, now: number = Date.now()): number | null {
    if (windowSamples <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < windowSamples) return null
    const vols: number[] = []
    for (let i = arr.length - windowSamples; i < arr.length; i++) {
      if (arr[i].v !== undefined) vols.push(arr[i].v!)
    }
    if (vols.length === 0) return null
    vols.sort((a, b) => a - b)
    return vols[Math.floor(vols.length / 2)]
  }

  /**
   * Price `windowSeconds` ago (first sample within the window boundary),
   * or null when the window hasn't filled yet.
   */
  public priceAt(symbol: string, windowSeconds: number, now: number = Date.now()): number | null {
    const arr = this.series.get(symbol)
    if (!arr || arr.length === 0) return null
    const boundary = now - windowSeconds * 1000
    if (arr[0].t > boundary) return null
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].t <= boundary) return arr[i].p
    }
    return arr[0].p
  }

  public momentumPct(symbol: string, windowSeconds: number, now: number = Date.now()): number | null {
    const last = this.lastPrice(symbol)
    if (last === null) return null
    const past = this.priceAt(symbol, windowSeconds, now)
    if (past === null || past <= 0) return null
    return ((last - past) / past) * 100
  }

  public rsi(symbol: string, period = 7, binSeconds = 5, now: number = Date.now()): number | null {
    const arr = this.series.get(symbol)
    if (!arr || arr.length < period + 2) return null
    return wildersRsi(binCloses(arr, binSeconds, now), period)
  }

  /**
   * Exponential moving average over the raw sample prices, seeded with the
   * SMA of the first `period` samples. Assumes roughly constant sampling
   * cadence (1s in the live loop) — period is a sample count.
   */
  public ema(symbol: string, period: number, now: number = Date.now()): number | null {
    if (period <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < period) return null
    const k = 2 / (period + 1)
    let value = 0
    for (let i = 0; i < period; i++) value += arr[i].p
    value /= period
    for (let i = period; i < arr.length; i++) {
      value = arr[i].p * k + value * (1 - k)
    }
    return value
  }

  /**
   * Rolling volatility proxy: stddev of per-sample returns over the last
   * `windowSamples` samples, in percent. With 1s samples this is per-second
   * volatility; scale by sqrt(seconds) to annualize to longer periods.
   */
  public volatilityPct(symbol: string, windowSamples: number, now: number = Date.now()): number | null {
    if (windowSamples <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < windowSamples + 1) return null
    const returns: number[] = []
    for (let i = arr.length - windowSamples; i < arr.length; i++) {
      const prev = arr[i - 1].p
      if (prev > 0) returns.push((arr[i].p - prev) / prev)
    }
    if (returns.length === 0) return null
    const m = returns.reduce((s, v) => s + v, 0) / returns.length
    const variance = returns.reduce((s, v) => s + (v - m) ** 2, 0) / returns.length
    return Math.sqrt(variance) * 100
  }

  /**
   * HAR-style multi-horizon volatility forecast (Corsi 2009): a weighted
   * blend of realized variance over short/mid/long windows. Lagged RV
   * strongly predicts future RV in crypto (Hu, Härdle & Kuo 2021), so the
   * blend is a smoother, more persistent vol estimate than a single window.
   * Returns per-sample stddev in %. Windows default to 1m/10m/1h of 1s
   * samples; horizons with insufficient data are dropped (lenient).
   */
  public harVolatilityPct(
    symbol: string,
    shortWindow = 60,
    midWindow = 600,
    longWindow = 3600,
    now: number = Date.now()
  ): number | null {
    const arr = this.series.get(symbol)
    if (!arr || arr.length < 2) return null
    // Only samples at/behind `now` count (live pushes arrive slightly ahead).
    let end = arr.length
    while (end > 0 && arr[end - 1].t > now) end--
    if (end < 2) return null

    const rv = (window: number): number | null => {
      if (window <= 0) return null
      const n = Math.min(window, end - 1)
      if (n < 1) return null
      // Mean-centered realized variance per horizon (same drift-insensitive
      // semantics as volatilityPct — a steady uptrend is NOT volatility).
      let sum = 0
      let sumSq = 0
      for (let i = end - n; i < end; i++) {
        const prev = arr[i - 1].p
        if (prev <= 0) return null
        const r = (arr[i].p - prev) / prev
        sum += r
        sumSq += r * r
      }
      const mean = sum / n
      return sumSq / n - mean * mean
    }

    const parts: Array<[number | null, number]> = [
      [rv(shortWindow), 0.5],
      [rv(midWindow), 0.3],
      [rv(longWindow), 0.2],
    ]
    const used = parts.filter(([v]) => v !== null && v > 0) as Array<[number, number]>
    if (used.length === 0) return null
    const wSum = used.reduce((s, [, w]) => s + w, 0)
    const variance = used.reduce((s, [v, w]) => s + w * v, 0) / wSum
    return Math.sqrt(variance) * 100
  }

  /**
   * Close-based Choppiness Index (0-100). 100·log10(Σ|Δp|/(max-min)) /
   * log10(n) — low (< ~40-50) = trending, high = choppy/ranging. Uses closes
   * (the feed has no intrabar h/l), a standard approximation of the
   * true-range CHOP. Returns 100 when the window is perfectly flat.
   */
  public choppiness(symbol: string, period: number, now: number = Date.now()): number | null {
    if (period <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < period) return null
    let end = arr.length
    while (end > 0 && arr[end - 1].t > now) end--
    if (end < period) return null
    let sumAbs = 0
    let max = -Infinity
    let min = Infinity
    for (let i = end - period; i < end; i++) {
      const p = arr[i].p
      if (p > max) max = p
      if (p < min) min = p
      if (i > 0) sumAbs += Math.abs(arr[i].p - arr[i - 1].p)
    }
    const range = max - min
    if (range <= 0 || sumAbs <= 0) return 100
    return (100 * Math.log10(sumAbs / range)) / Math.log10(period)
  }

  /**
   * CUSUM-style trend-break statistic: cumulative (ema − price)/ema over the
   * last `windowSeconds`, in %. Positive = price spent most of the window
   * below its EMA (bearish for a BUY position). The changepoint-detection
   * literature (Wood, Roberts & Zohren 2021) shows trend bets should be cut
   * on regime breaks rather than waiting for a slow EMA cross. Null while
   * the EMA or window has not filled.
   */
  public cusumDeviationPct(
    symbol: string,
    period: number,
    windowSeconds: number,
    now: number = Date.now()
  ): number | null {
    if (period <= 0 || windowSeconds <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < period + 1) return null
    const k = 2 / (period + 1)
    let ema = 0
    for (let i = 0; i < period; i++) ema += arr[i].p
    ema /= period
    const boundary = now - windowSeconds * 1000
    let sum = 0
    let has = false
    for (let i = period; i < arr.length; i++) {
      ema = arr[i].p * k + ema * (1 - k)
      if (arr[i].t > boundary) {
        if (ema > 0) sum += (ema - arr[i].p) / ema
        has = true
      }
    }
    return has ? sum * 100 : null
  }

  /** Worst single-sample down move in % over the last `windowSamples` (negative or 0). */
  public maxDownMovePct(symbol: string, windowSamples: number, now: number = Date.now()): number | null {
    if (windowSamples <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < windowSamples + 1) return null
    let end = arr.length
    while (end > 0 && arr[end - 1].t > now) end--
    if (end < windowSamples + 1) return null
    let worst = 0
    for (let i = end - windowSamples; i < end; i++) {
      const prev = arr[i - 1].p
      if (prev > 0) {
        const r = ((arr[i].p - prev) / prev) * 100
        if (r < worst) worst = r
      }
    }
    return worst
  }

  /**
   * Percent change of the EMA over `windowSeconds` — the trend-direction
   * filter for trend mode. EMA computed over the raw samples (same
   * semantics as `ema()`); the "past" value is the EMA at the last sample
   * at/behind the boundary. Null while the window hasn't filled.
   */
  public emaSlopePct(
    symbol: string,
    period: number,
    windowSeconds: number,
    now: number = Date.now()
  ): number | null {
    if (period <= 0 || windowSeconds <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < period + 1) return null
    const k = 2 / (period + 1)
    let value = 0
    for (let i = 0; i < period; i++) value += arr[i].p
    value /= period
    const boundary = now - windowSeconds * 1000
    let past: number | null = null
    for (let i = period; i < arr.length; i++) {
      value = arr[i].p * k + value * (1 - k)
      if (arr[i].t <= boundary) past = value
    }
    if (past === null || past <= 0) return null
    return ((value - past) / past) * 100
  }

  /**
   * Kaufman efficiency ratio over the last `windowDays` days: |net move| /
   * path length, in percent (0-100). 100 = perfectly directional, ~0 =
   * random walk/chop. Computed on a daily close grid derived from the
   * sample cadence (one close per ~day), so it stays cheap on any bar size.
   * Null while the lookback hasn't filled.
   */
  public efficiencyRatioPct(symbol: string, windowDays: number, now: number = Date.now()): number | null {
    if (windowDays <= 0) return null
    const arr = this.series.get(symbol)
    if (!arr || arr.length < 4) return null
    // Median inter-sample gap → daily step in samples.
    const gaps: number[] = []
    for (let i = Math.max(1, arr.length - 12); i < arr.length; i++) {
      gaps.push(arr[i].t - arr[i - 1].t)
    }
    gaps.sort((a, b) => a - b)
    const gapMs = gaps[Math.floor(gaps.length / 2)] || 0
    if (gapMs <= 0) return null
    const perDay = Math.max(1, Math.round(86_400_000 / gapMs))
    const needed = windowDays * perDay
    if (arr.length < needed + 2) return null

    const closes: number[] = []
    for (let i = arr.length - 1; i >= 0 && closes.length <= windowDays; i -= perDay) {
      closes.push(arr[i].p)
    }
    if (closes.length < windowDays + 1) return null
    let path = 0
    for (let i = 0; i < closes.length - 1; i++) {
      path += Math.abs(closes[i + 1] - closes[i])
    }
    const net = Math.abs(closes[0] - closes[closes.length - 1])
    if (path <= 0) return 0
    return (net / path) * 100
  }

  /**
   * Combined entry gate for the intraminute loop.
   * Passes when momentum over the window clears the threshold and RSI is
   * between the configured bounds. Missing RSI data is lenient (momentum
   * alone can trigger) — the momentum window is the primary signal.
   */
  public score(
    symbol: string,
    opts: {
      windowSeconds: number
      thresholdPct: number
      rsiLow: number
      rsiHigh: number
      now?: number
    }
  ): MomentumScore {
    const now = opts.now ?? Date.now()
    const momentumPct = this.momentumPct(symbol, opts.windowSeconds, now)
    if (momentumPct === null) {
      return { pass: false, reason: `no momentum data for ${symbol}`, momentumPct: null, rsi: null }
    }

    if (momentumPct < opts.thresholdPct) {
      return {
        pass: false,
        reason: `momentum ${momentumPct.toFixed(3)}% < threshold ${opts.thresholdPct}%`,
        momentumPct,
        rsi: null,
      }
    }

    const rsi = this.rsi(symbol, 7, 5, now)
    if (rsi === null) {
      return { pass: true, reason: `momentum ${momentumPct.toFixed(3)}% (RSI warming up)`, momentumPct, rsi: null }
    }
    if (rsi >= opts.rsiHigh) {
      return { pass: false, reason: `RSI ${rsi.toFixed(1)} overbought (>= ${opts.rsiHigh})`, momentumPct, rsi }
    }
    if (rsi <= opts.rsiLow) {
      return { pass: false, reason: `RSI ${rsi.toFixed(1)} weak (<= ${opts.rsiLow})`, momentumPct, rsi }
    }
    return { pass: true, reason: `momentum ${momentumPct.toFixed(3)}%, RSI ${rsi.toFixed(1)}`, momentumPct, rsi }
  }
}

export default new MomentumFeed()
