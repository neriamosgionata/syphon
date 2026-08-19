// ─── Intraminute momentum feed ────────────────────────────────
//
// Pure in-memory rolling price series fed from the live Kraken WS cache.
// No DB, no env, no external deps — unit-testable in isolation.

export interface MomentumSample {
  t: number
  p: number
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
  private maxSamples = 2400 // 40 minutes at 1s sampling

  public push(symbol: string, price: number, t: number = Date.now()): void {
    if (!Number.isFinite(price) || price <= 0) return
    let arr = this.series.get(symbol)
    if (!arr) {
      arr = []
      this.series.set(symbol, arr)
    }
    arr.push({ t, p: price })
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
