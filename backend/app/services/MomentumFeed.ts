// ─── Intraminute momentum feed ────────────────────────────────
//
// Pure in-memory rolling price series fed from the live Kraken WS cache.
// No DB, no env, no external deps — unit-testable in isolation.

export interface MomentumSample {
  t: number
  p: number
  /** Optional per-sample volume (Binance 1s klines). Null/absent live. */
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
