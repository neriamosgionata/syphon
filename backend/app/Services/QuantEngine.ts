import Logger from '@ioc:Adonis/Core/Logger'
import Ticker from 'App/Models/Ticker'
import TickerSnapshot from 'App/Models/TickerSnapshot'
import Database from '@ioc:Adonis/Lucid/Database'

// ─── Data Types ──────────────────────────────────────────────

interface Bar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface MACDResult {
  macd: number
  signal: number
  histogram: number
  series: Array<{ date: string; macd: number; signal: number; histogram: number }>
}

interface BollingerResult {
  upper: number
  middle: number
  lower: number
  width: number
  percentB: number
  series: Array<{ date: string; upper: number; middle: number; lower: number }>
}

interface StochasticResult {
  k: number
  d: number
  series: Array<{ date: string; k: number; d: number }>
}

interface ADXResult {
  adx: number
  plusDI: number
  minusDI: number
  series: Array<{ date: string; adx: number; plusDI: number; minusDI: number }>
}

interface PatternSignal {
  type: string
  signal: 'bullish' | 'bearish' | 'neutral'
  strength: number // 0-100
  description: string
  date?: string
}

export interface TickerAnalysis {
  symbol: string
  name: string
  exchange: string | null
  currentPrice: number | null
  dataPoints: number

  // Moving averages
  sma20: number | null
  sma50: number | null
  sma200: number | null
  ema12: number | null
  ema26: number | null

  // Oscillators
  rsi14: number | null
  macd: MACDResult | null
  stochastic: StochasticResult | null
  adx: ADXResult | null

  // Volatility
  bollingerBands: BollingerResult | null
  atr14: number | null
  volatility20d: number | null
  volatility60d: number | null

  // Volume
  obv: number | null
  obvTrend: 'rising' | 'falling' | 'flat' | null
  volumeSma20: number | null
  volumeRatio: number | null // current volume vs 20d avg

  // Returns & risk
  returnDaily: number | null
  return5d: number | null
  return20d: number | null
  return60d: number | null
  return252d: number | null
  sharpeRatio: number | null
  sortinoRatio: number | null
  maxDrawdown: number | null
  beta: number | null

  // Fundamentals (from ticker metadata)
  pe: number | null
  eps: number | null
  dividendYield: number | null
  marketCap: number | null

  // Patterns & signals
  patterns: PatternSignal[]
  compositeScore: number // -100 to 100
  quantSignal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell'
}

export interface ScreenerResult {
  generated_at: string
  count: number
  tickers: Array<{
    symbol: string
    name: string
    price: number | null
    rsi14: number | null
    macd_histogram: number | null
    sma_trend: 'bullish' | 'bearish' | 'neutral' | null
    bollinger_position: number | null
    volatility20d: number | null
    volume_ratio: number | null
    return20d: number | null
    sharpe: number | null
    beta: number | null
    max_drawdown: number | null
    composite_score: number
    signal: string
    patterns: string[]
  }>
}

// ─── Math Helpers ────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr: number[], avg?: number): number {
  const m = avg ?? mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
}

function sma(data: number[], period: number): number | null {
  if (data.length < period) return null
  return mean(data.slice(-period))
}

function smaSeries(data: number[], period: number): number[] {
  const result: number[] = []
  for (let i = period - 1; i < data.length; i++) {
    result.push(mean(data.slice(i - period + 1, i + 1)))
  }
  return result
}

function ema(data: number[], period: number): number[] {
  if (data.length < period) return []
  const k = 2 / (period + 1)
  const result: number[] = [mean(data.slice(0, period))]
  for (let i = period; i < data.length; i++) {
    result.push(data[i] * k + result[result.length - 1] * (1 - k))
  }
  return result
}

function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let avgGain = 0
  let avgLoss = 0

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss += Math.abs(diff)
  }
  avgGain /= period
  avgLoss /= period

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function computeRSISeries(closes: number[], period = 14): Array<{ index: number; value: number }> {
  if (closes.length < period + 1) return []
  let avgGain = 0
  let avgLoss = 0
  const result: Array<{ index: number; value: number }> = []

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss += Math.abs(diff)
  }
  avgGain /= period
  avgLoss /= period

  const rs0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  result.push({ index: period, value: rs0 })

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    result.push({ index: i, value: rsi })
  }

  return result
}

function computeMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  sig = 9
): MACDResult | null {
  if (closes.length < slow + sig) return null
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)

  // Align: emaSlow starts at index (slow-1), emaFast at (fast-1)
  // MACD line = emaFast - emaSlow, aligned from the slow EMA start
  const offset = slow - fast
  const macdLine: number[] = []
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i])
  }

  const signalLine = ema(macdLine, sig)
  if (signalLine.length === 0) return null

  const signalOffset = sig - 1
  const series: MACDResult['series'] = []
  for (let i = 0; i < signalLine.length; i++) {
    const macdIdx = i + signalOffset
    const barIdx = slow - 1 + macdIdx
    series.push({
      date: '', // filled by caller
      macd: macdLine[macdIdx],
      signal: signalLine[i],
      histogram: macdLine[macdIdx] - signalLine[i],
    })
  }

  const last = series[series.length - 1]
  return {
    macd: last.macd,
    signal: last.signal,
    histogram: last.histogram,
    series,
  }
}

function computeBollingerBands(
  closes: number[],
  period = 20,
  mult = 2
): BollingerResult | null {
  if (closes.length < period) return null

  const series: BollingerResult['series'] = []
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const m = mean(slice)
    const sd = stddev(slice, m)
    series.push({
      date: '',
      upper: m + mult * sd,
      middle: m,
      lower: m - mult * sd,
    })
  }

  const last = series[series.length - 1]
  const width = (last.upper - last.lower) / last.middle
  const percentB = last.upper !== last.lower
    ? (closes[closes.length - 1] - last.lower) / (last.upper - last.lower)
    : 0.5

  return { ...last, width, percentB, series }
}

function computeATR(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null

  const trueRanges: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    )
    trueRanges.push(tr)
  }

  let atr = mean(trueRanges.slice(0, period))
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
  }
  return atr
}

function computeStochastic(
  bars: Bar[],
  kPeriod = 14,
  dPeriod = 3
): StochasticResult | null {
  if (bars.length < kPeriod + dPeriod - 1) return null

  const kValues: number[] = []
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1)
    const low = Math.min(...slice.map((b) => b.low))
    const high = Math.max(...slice.map((b) => b.high))
    const k = high !== low ? ((bars[i].close - low) / (high - low)) * 100 : 50
    kValues.push(k)
  }

  const series: StochasticResult['series'] = []
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    const d = mean(kValues.slice(i - dPeriod + 1, i + 1))
    series.push({ date: '', k: kValues[i], d })
  }

  const last = series[series.length - 1]
  return { k: last.k, d: last.d, series }
}

function computeADX(bars: Bar[], period = 14): ADXResult | null {
  if (bars.length < period * 2 + 1) return null

  const plusDM: number[] = []
  const minusDM: number[] = []
  const tr: number[] = []

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high
    const downMove = bars[i - 1].low - bars[i].low
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    ))
  }

  // Wilder's smoothing
  let smoothTR = mean(tr.slice(0, period)) * period
  let smoothPlusDM = mean(plusDM.slice(0, period)) * period
  let smoothMinusDM = mean(minusDM.slice(0, period)) * period

  const diPlus: number[] = []
  const diMinus: number[] = []
  const dx: number[] = []

  for (let i = period; i < tr.length; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i]
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i]
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i]

    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0
    diPlus.push(pdi)
    diMinus.push(mdi)
    const sum = pdi + mdi
    dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0)
  }

  if (dx.length < period) return null

  let adx = mean(dx.slice(0, period))
  const series: ADXResult['series'] = []

  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period
    series.push({
      date: '',
      adx,
      plusDI: diPlus[i],
      minusDI: diMinus[i],
    })
  }

  const last = series[series.length - 1]
  return { adx: last.adx, plusDI: last.plusDI, minusDI: last.minusDI, series }
}

function computeOBV(bars: Bar[]): { obv: number; series: number[] } {
  let obv = 0
  const series = [0]
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close > bars[i - 1].close) obv += bars[i].volume
    else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume
    series.push(obv)
  }
  return { obv, series }
}

function computeReturns(closes: number[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1])
  }
  return returns
}

function computeSharpe(returns: number[], riskFreeDaily = 0.0002): number | null {
  if (returns.length < 20) return null
  const excessReturns = returns.map((r) => r - riskFreeDaily)
  const avg = mean(excessReturns)
  const sd = stddev(excessReturns)
  if (sd === 0) return 0
  return (avg / sd) * Math.sqrt(252)
}

function computeSortino(returns: number[], riskFreeDaily = 0.0002): number | null {
  if (returns.length < 20) return null
  const excessReturns = returns.map((r) => r - riskFreeDaily)
  const avg = mean(excessReturns)
  const downside = returns.filter((r) => r < riskFreeDaily).map((r) => (r - riskFreeDaily) ** 2)
  if (downside.length === 0) return avg > 0 ? 99 : 0
  const downsideDev = Math.sqrt(mean(downside))
  if (downsideDev === 0) return 0
  return (avg / downsideDev) * Math.sqrt(252)
}

function computeMaxDrawdown(closes: number[]): number | null {
  if (closes.length < 2) return null
  let peak = closes[0]
  let maxDD = 0
  for (const c of closes) {
    if (c > peak) peak = c
    const dd = (peak - c) / peak
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

function computeBeta(tickerReturns: number[], benchmarkReturns: number[]): number | null {
  const len = Math.min(tickerReturns.length, benchmarkReturns.length)
  if (len < 20) return null
  const tr = tickerReturns.slice(-len)
  const br = benchmarkReturns.slice(-len)
  const meanTR = mean(tr)
  const meanBR = mean(br)
  let cov = 0
  let varB = 0
  for (let i = 0; i < len; i++) {
    cov += (tr[i] - meanTR) * (br[i] - meanBR)
    varB += (br[i] - meanBR) ** 2
  }
  if (varB === 0) return null
  return cov / varB
}

function priceChange(closes: number[], days: number): number | null {
  if (closes.length <= days) return null
  const recent = closes[closes.length - 1]
  const past = closes[closes.length - 1 - days]
  return (recent - past) / past
}

// ─── Pattern Detection ───────────────────────────────────────

function detectPatterns(
  bars: Bar[],
  closes: number[],
  rsi: number | null,
  macd: MACDResult | null,
  bb: BollingerResult | null,
  sma50Val: number | null,
  sma200Val: number | null,
  adx: ADXResult | null,
  volumeRatio: number | null
): PatternSignal[] {
  const patterns: PatternSignal[] = []
  const price = closes[closes.length - 1]

  // Golden / Death Cross
  if (sma50Val && sma200Val) {
    const sma50Series = smaSeries(closes, 50)
    const sma200Series = smaSeries(closes, 200)
    if (sma50Series.length >= 2 && sma200Series.length >= 2) {
      const prev50 = sma50Series[sma50Series.length - 2]
      const prev200 = sma200Series[sma200Series.length - 2]
      if (prev50 < prev200 && sma50Val > sma200Val) {
        patterns.push({
          type: 'golden_cross',
          signal: 'bullish',
          strength: 85,
          description: 'SMA 50 crossed above SMA 200 (Golden Cross)',
        })
      } else if (prev50 > prev200 && sma50Val < sma200Val) {
        patterns.push({
          type: 'death_cross',
          signal: 'bearish',
          strength: 85,
          description: 'SMA 50 crossed below SMA 200 (Death Cross)',
        })
      }
    }

    // Trend alignment
    if (price > sma50Val && sma50Val > sma200Val) {
      patterns.push({
        type: 'uptrend',
        signal: 'bullish',
        strength: 60,
        description: 'Price above SMA 50 above SMA 200 — established uptrend',
      })
    } else if (price < sma50Val && sma50Val < sma200Val) {
      patterns.push({
        type: 'downtrend',
        signal: 'bearish',
        strength: 60,
        description: 'Price below SMA 50 below SMA 200 — established downtrend',
      })
    }
  }

  // MACD crossover
  if (macd && macd.series.length >= 2) {
    const prev = macd.series[macd.series.length - 2]
    const curr = macd.series[macd.series.length - 1]
    if (prev.histogram < 0 && curr.histogram > 0) {
      patterns.push({
        type: 'macd_bullish_cross',
        signal: 'bullish',
        strength: 70,
        description: 'MACD line crossed above signal line',
      })
    } else if (prev.histogram > 0 && curr.histogram < 0) {
      patterns.push({
        type: 'macd_bearish_cross',
        signal: 'bearish',
        strength: 70,
        description: 'MACD line crossed below signal line',
      })
    }

    // MACD divergence (simplified: price making new high but MACD isn't)
    if (closes.length >= 20) {
      const recentHigh = Math.max(...closes.slice(-20))
      const prevHigh = Math.max(...closes.slice(-40, -20))
      if (recentHigh > prevHigh && curr.macd < Math.max(...macd.series.slice(-40, -20).map(s => s.macd))) {
        patterns.push({
          type: 'bearish_divergence',
          signal: 'bearish',
          strength: 75,
          description: 'Price making higher high but MACD is lower — bearish divergence',
        })
      }
    }
  }

  // RSI signals
  if (rsi !== null) {
    if (rsi < 30) {
      patterns.push({
        type: 'rsi_oversold',
        signal: 'bullish',
        strength: Math.min(90, Math.round(60 + (30 - rsi) * 2)),
        description: `RSI at ${rsi.toFixed(1)} — oversold territory`,
      })
    } else if (rsi > 70) {
      patterns.push({
        type: 'rsi_overbought',
        signal: 'bearish',
        strength: Math.min(90, Math.round(60 + (rsi - 70) * 2)),
        description: `RSI at ${rsi.toFixed(1)} — overbought territory`,
      })
    }
  }

  // Bollinger Band signals
  if (bb) {
    if (bb.percentB > 1) {
      patterns.push({
        type: 'bb_upper_breakout',
        signal: 'bearish',
        strength: 65,
        description: 'Price above upper Bollinger Band — potential overbought',
      })
    } else if (bb.percentB < 0) {
      patterns.push({
        type: 'bb_lower_breakout',
        signal: 'bullish',
        strength: 65,
        description: 'Price below lower Bollinger Band — potential oversold',
      })
    }

    // Bollinger squeeze (low width = imminent breakout)
    if (bb.series.length >= 20) {
      const widths = bb.series.slice(-20).map((s) => (s.upper - s.lower) / s.middle)
      const avgWidth = mean(widths)
      if (bb.width < avgWidth * 0.6) {
        patterns.push({
          type: 'bb_squeeze',
          signal: 'neutral',
          strength: 70,
          description: 'Bollinger Band squeeze — volatility contraction, breakout imminent',
        })
      }
    }
  }

  // Volume spike
  if (volumeRatio !== null && volumeRatio > 2.0) {
    patterns.push({
      type: 'volume_spike',
      signal: 'neutral',
      strength: Math.min(80, Math.round(50 + (volumeRatio - 2) * 15)),
      description: `Volume ${volumeRatio.toFixed(1)}x above 20-day average — unusual activity`,
    })
  }

  // ADX trend strength
  if (adx) {
    if (adx.adx > 25 && adx.plusDI > adx.minusDI) {
      patterns.push({
        type: 'strong_uptrend_adx',
        signal: 'bullish',
        strength: Math.min(85, Math.round(40 + adx.adx)),
        description: `ADX ${adx.adx.toFixed(1)} with +DI > -DI — strong uptrend`,
      })
    } else if (adx.adx > 25 && adx.minusDI > adx.plusDI) {
      patterns.push({
        type: 'strong_downtrend_adx',
        signal: 'bearish',
        strength: Math.min(85, Math.round(40 + adx.adx)),
        description: `ADX ${adx.adx.toFixed(1)} with -DI > +DI — strong downtrend`,
      })
    }
  }

  // Stochastic crossover
  const stoch = computeStochastic(bars)
  if (stoch && stoch.series.length >= 2) {
    const prev = stoch.series[stoch.series.length - 2]
    const curr = stoch.series[stoch.series.length - 1]
    if (prev.k < prev.d && curr.k > curr.d && curr.k < 20) {
      patterns.push({
        type: 'stoch_bullish_cross',
        signal: 'bullish',
        strength: 65,
        description: 'Stochastic %K crossed above %D in oversold zone',
      })
    } else if (prev.k > prev.d && curr.k < curr.d && curr.k > 80) {
      patterns.push({
        type: 'stoch_bearish_cross',
        signal: 'bearish',
        strength: 65,
        description: 'Stochastic %K crossed below %D in overbought zone',
      })
    }
  }

  return patterns
}

// ─── Composite Score ─────────────────────────────────────────

function computeCompositeScore(
  rsi: number | null,
  macd: MACDResult | null,
  bb: BollingerResult | null,
  sma20: number | null,
  sma50: number | null,
  sma200: number | null,
  adx: ADXResult | null,
  stoch: StochasticResult | null,
  volumeRatio: number | null,
  return20d: number | null,
  sharpe: number | null,
  beta: number | null,
  pe: number | null,
  price: number,
  patterns: PatternSignal[]
): number {
  let score = 0
  let weights = 0

  // RSI (weight 15)
  if (rsi !== null) {
    // 30 → +100, 50 → 0, 70 → -100
    const rsiScore = Math.max(-100, Math.min(100, (50 - rsi) * 5))
    score += rsiScore * 15
    weights += 15
  }

  // MACD (weight 15)
  if (macd) {
    const macdScore = Math.max(-100, Math.min(100, macd.histogram * 500))
    score += macdScore * 15
    weights += 15
  }

  // Bollinger %B (weight 10) — lower = more oversold = bullish
  if (bb) {
    const bbScore = Math.max(-100, Math.min(100, (0.5 - bb.percentB) * 200))
    score += bbScore * 10
    weights += 10
  }

  // Trend alignment (weight 15)
  if (sma20 && sma50 && sma200) {
    let trendScore = 0
    if (price > sma20) trendScore += 33
    else trendScore -= 33
    if (sma20 > sma50) trendScore += 33
    else trendScore -= 33
    if (sma50 > sma200) trendScore += 34
    else trendScore -= 34
    score += trendScore * 15
    weights += 15
  }

  // ADX directional (weight 10)
  if (adx && adx.adx > 20) {
    const diScore = adx.plusDI > adx.minusDI
      ? Math.min(100, (adx.plusDI - adx.minusDI) * 3)
      : Math.max(-100, (adx.plusDI - adx.minusDI) * 3)
    score += diScore * 10
    weights += 10
  }

  // Stochastic (weight 10)
  if (stoch) {
    const stochScore = Math.max(-100, Math.min(100, (50 - stoch.k) * 2.5))
    score += stochScore * 10
    weights += 10
  }

  // Volume confirmation (weight 5)
  if (volumeRatio !== null && return20d !== null) {
    const volScore = return20d > 0 && volumeRatio > 1.2 ? 50
      : return20d < 0 && volumeRatio > 1.2 ? -50
      : 0
    score += volScore * 5
    weights += 5
  }

  // Momentum (weight 10)
  if (return20d !== null) {
    const momScore = Math.max(-100, Math.min(100, return20d * 500))
    score += momScore * 10
    weights += 10
  }

  // Sharpe ratio (weight 5)
  if (sharpe !== null) {
    const sharpeScore = Math.max(-100, Math.min(100, sharpe * 40))
    score += sharpeScore * 5
    weights += 5
  }

  // Fundamentals P/E (weight 5)
  if (pe !== null && pe > 0) {
    const peScore = pe < 15 ? 60 : pe < 25 ? 20 : pe < 40 ? -20 : -60
    score += peScore * 5
    weights += 5
  }

  return weights > 0 ? Math.round(score / weights) : 0
}

function classifySignal(score: number): TickerAnalysis['quantSignal'] {
  if (score >= 40) return 'strong_buy'
  if (score >= 15) return 'buy'
  if (score <= -40) return 'strong_sell'
  if (score <= -15) return 'sell'
  return 'neutral'
}

// ─── Main Service ────────────────────────────────────────────

class QuantEngineService {
  private spyReturnsCache: { returns: number[]; cachedAt: number } | null = null

  private async getSPYReturns(): Promise<number[]> {
    if (this.spyReturnsCache && Date.now() - this.spyReturnsCache.cachedAt < 3600_000) {
      return this.spyReturnsCache.returns
    }

    const spy = await Ticker.findBy('symbol', 'SPY')
    if (!spy) return []

    const snapshots = await TickerSnapshot.query()
      .where('ticker_id', spy.id)
      .orderBy('date', 'asc')

    const closes = snapshots.map((s) => s.close!).filter(Boolean)
    const returns = computeReturns(closes)
    this.spyReturnsCache = { returns, cachedAt: Date.now() }
    return returns
  }

  public async analyzeTicker(symbol: string): Promise<TickerAnalysis | null> {
    const ticker = await Ticker.query()
      .where('symbol', symbol.toUpperCase())
      .where('is_active', true)
      .first()

    if (!ticker) return null

    const snapshots = await TickerSnapshot.query()
      .where('ticker_id', ticker.id)
      .orderBy('date', 'asc')

    if (snapshots.length < 5) {
      Logger.warn('[Quant] Insufficient data for %s (%d bars)', symbol, snapshots.length)
      return null
    }

    const bars: Bar[] = snapshots.map((s) => ({
      date: s.date,
      open: Number(s.open || s.close) || 0,
      high: Number(s.high || s.close) || 0,
      low: Number(s.low || s.close) || 0,
      close: Number(s.close) || 0,
      volume: Number(s.volume) || 0,
    }))

    const closes = bars.map((b) => b.close)
    const volumes = bars.map((b) => b.volume)
    const returns = computeReturns(closes)
    const price = closes[closes.length - 1]

    // Moving averages
    const sma20 = sma(closes, 20)
    const sma50 = sma(closes, 50)
    const sma200 = sma(closes, 200)
    const ema12Series = ema(closes, 12)
    const ema26Series = ema(closes, 26)
    const ema12Val = ema12Series.length > 0 ? ema12Series[ema12Series.length - 1] : null
    const ema26Val = ema26Series.length > 0 ? ema26Series[ema26Series.length - 1] : null

    // Oscillators
    const rsi14 = computeRSI(closes, 14)
    const macdResult = computeMACD(closes, 12, 26, 9)
    const stochResult = computeStochastic(bars, 14, 3)
    const adxResult = computeADX(bars, 14)

    // Volatility
    const bbResult = computeBollingerBands(closes, 20, 2)
    const atr14 = computeATR(bars, 14)
    const vol20d = returns.length >= 20 ? stddev(returns.slice(-20)) * Math.sqrt(252) : null
    const vol60d = returns.length >= 60 ? stddev(returns.slice(-60)) * Math.sqrt(252) : null

    // Volume
    const obvResult = computeOBV(bars)
    const volumeSma20 = sma(volumes, 20)
    const currentVol = volumes[volumes.length - 1]
    const volumeRatio = volumeSma20 && volumeSma20 > 0 ? currentVol / volumeSma20 : null

    // OBV trend (20-bar regression direction)
    let obvTrend: 'rising' | 'falling' | 'flat' | null = null
    if (obvResult.series.length >= 20) {
      const recentOBV = obvResult.series.slice(-20)
      const first5 = mean(recentOBV.slice(0, 5))
      const last5 = mean(recentOBV.slice(-5))
      const diff = (last5 - first5) / (Math.abs(first5) || 1)
      obvTrend = diff > 0.05 ? 'rising' : diff < -0.05 ? 'falling' : 'flat'
    }

    // Returns & risk
    const spyReturns = await this.getSPYReturns()
    const betaVal = computeBeta(returns, spyReturns)
    const sharpe = computeSharpe(returns)
    const sortino = computeSortino(returns)
    const maxDD = computeMaxDrawdown(closes)

    // Fundamentals
    const meta = ticker.metadata || {}
    const pe = meta.pe || null
    const eps = meta.eps || null
    const dividendYield = meta.dividendYield || null

    // Patterns
    const patterns = detectPatterns(
      bars, closes, rsi14, macdResult, bbResult, sma50, sma200, adxResult, volumeRatio
    )

    // Composite score
    const compositeScore = computeCompositeScore(
      rsi14, macdResult, bbResult, sma20, sma50, sma200,
      adxResult, stochResult, volumeRatio, priceChange(closes, 20),
      sharpe, betaVal, pe, price, patterns
    )

    // Fill dates in series data
    if (macdResult) {
      const startIdx = bars.length - macdResult.series.length
      macdResult.series.forEach((s, i) => { s.date = bars[startIdx + i]?.date || '' })
    }
    if (bbResult) {
      const startIdx = bars.length - bbResult.series.length
      bbResult.series.forEach((s, i) => { s.date = bars[startIdx + i]?.date || '' })
    }
    if (stochResult) {
      const startIdx = bars.length - stochResult.series.length
      stochResult.series.forEach((s, i) => { s.date = bars[startIdx + i]?.date || '' })
    }
    if (adxResult) {
      const startIdx = bars.length - adxResult.series.length
      adxResult.series.forEach((s, i) => { s.date = bars[startIdx + i]?.date || '' })
    }

    return {
      symbol: ticker.symbol,
      name: ticker.name,
      exchange: ticker.exchange,
      currentPrice: ticker.currentPrice,
      dataPoints: bars.length,

      sma20,
      sma50,
      sma200,
      ema12: ema12Val,
      ema26: ema26Val,

      rsi14,
      macd: macdResult,
      stochastic: stochResult,
      adx: adxResult,

      bollingerBands: bbResult,
      atr14,
      volatility20d: vol20d,
      volatility60d: vol60d,

      obv: obvResult.obv,
      obvTrend,
      volumeSma20,
      volumeRatio,

      returnDaily: priceChange(closes, 1),
      return5d: priceChange(closes, 5),
      return20d: priceChange(closes, 20),
      return60d: priceChange(closes, 60),
      return252d: priceChange(closes, 252),
      sharpeRatio: sharpe,
      sortinoRatio: sortino,
      maxDrawdown: maxDD,
      beta: betaVal,

      pe,
      eps,
      dividendYield,
      marketCap: ticker.marketCap,

      patterns,
      compositeScore,
      quantSignal: classifySignal(compositeScore),
    }
  }

  public async screener(): Promise<ScreenerResult> {
    const tickers = await Ticker.query().where('is_active', true).orderBy('symbol')

    const results: ScreenerResult['tickers'] = []

    for (const ticker of tickers) {
      try {
        const analysis = await this.analyzeTicker(ticker.symbol)
        if (!analysis) continue

        const smaTrend: 'bullish' | 'bearish' | 'neutral' | null =
          analysis.sma50 && analysis.sma200
            ? analysis.sma50 > analysis.sma200 ? 'bullish' : 'bearish'
            : null

        results.push({
          symbol: analysis.symbol,
          name: analysis.name,
          price: analysis.currentPrice,
          rsi14: analysis.rsi14 ? Math.round(analysis.rsi14 * 10) / 10 : null,
          macd_histogram: analysis.macd ? Math.round(analysis.macd.histogram * 100) / 100 : null,
          sma_trend: smaTrend,
          bollinger_position: analysis.bollingerBands ? Math.round(analysis.bollingerBands.percentB * 100) / 100 : null,
          volatility20d: analysis.volatility20d ? Math.round(analysis.volatility20d * 1000) / 10 : null,
          volume_ratio: analysis.volumeRatio ? Math.round(analysis.volumeRatio * 100) / 100 : null,
          return20d: analysis.return20d ? Math.round(analysis.return20d * 10000) / 100 : null,
          sharpe: analysis.sharpeRatio ? Math.round(analysis.sharpeRatio * 100) / 100 : null,
          beta: analysis.beta ? Math.round(analysis.beta * 100) / 100 : null,
          max_drawdown: analysis.maxDrawdown ? Math.round(analysis.maxDrawdown * 10000) / 100 : null,
          composite_score: analysis.compositeScore,
          signal: analysis.quantSignal,
          patterns: analysis.patterns.map((p) => p.type),
        })
      } catch (err) {
        Logger.warn('[Quant] Failed to analyze %s: %s', ticker.symbol, err.message)
      }
    }

    results.sort((a, b) => b.composite_score - a.composite_score)

    return {
      generated_at: new Date().toISOString(),
      count: results.length,
      tickers: results,
    }
  }
}

// Export static math functions for unit testing
export const _internals = {
  sma,
  smaSeries,
  ema,
  computeRSI,
  computeRSISeries,
  computeMACD,
  computeBollingerBands,
  computeATR,
  computeStochastic,
  computeADX,
  computeOBV,
  computeReturns,
  computeSharpe,
  computeSortino,
  computeMaxDrawdown,
  computeBeta,
  computeCompositeScore,
  classifySignal,
  detectPatterns,
  mean,
  stddev,
  priceChange,
}

export default new QuantEngineService()
