import logger from '@adonisjs/core/services/logger'
import Ticker from '#models/Ticker'
import MeilisearchService from './MeilisearchService.js'
import { newsWindowScore, analysesToNewsEvents } from './NewsScore.js'

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
  name: string
  type: 'bullish' | 'bearish' | 'neutral'
  strength: number // 0-1
  description: string
  date?: string
}

interface SentimentData {
  totalArticles: number
  avgScore: number
  recentTrend: number
}

interface ScoreBreakdown {
  // Technical (65%)
  rsi: number
  macd: number
  bollingerBands: number
  trend: number
  adx: number
  stochastic: number
  momentum: number
  volume: number
  patterns: number
  // Sentiment (20%)
  sentiment: number
  sentimentMomentum: number
  newsVolume: number
  // Risk/Fundamentals (15%)
  sharpe: number
  beta: number
  pe: number
  fiftyTwoWeek: number
}

interface TradingRecommendation {
  action: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell'
  conviction: number // 0-1
  regime: 'trending_up' | 'trending_down' | 'ranging' | 'volatile' | 'unknown'
  positionSize: number // 0-1 as fraction of portfolio
  stopLoss: number | null
  takeProfit: number | null
  riskRewardRatio: number | null
}

export interface TickerAnalysis {
  symbol: string
  name: string
  exchange: string | null
  currentPrice: number | null
  dataPoints: number
  /** Fraction of the 16 composite components that had data (0-1). */
  coverage: number

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
  volumeRatio: number | null

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

  // Fundamentals
  pe: number | null
  eps: number | null
  dividendYield: number | null
  marketCap: number | null

  // Sentiment (merged from TradingSignalService)
  sentiment: SentimentData | null

  // Patterns & signals
  patterns: PatternSignal[]
  compositeScore: number // -100 to 100
  quantSignal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell'
  scoreBreakdown: ScoreBreakdown
  recommendation: TradingRecommendation
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
    sentiment_score: number | null
    article_count: number
    composite_score: number
    signal: string
    conviction: number
    regime: string
    patterns: string[]
  }>
}

// ─── Math Helpers ────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr: number[], avg?: number): number {
  if (arr.length === 0) return 0
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

  // FIX #2: flat prices → avgGain=0 and avgLoss=0 → RSI=50 (neutral), not 100
  if (avgGain === 0 && avgLoss === 0) return 50
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

  const rs0 = (avgGain === 0 && avgLoss === 0) ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  result.push({ index: period, value: rs0 })

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period
    const rsi = (avgGain === 0 && avgLoss === 0) ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
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
    series.push({
      date: '',
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
  const width = last.middle !== 0 ? (last.upper - last.lower) / last.middle : 0
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
    // FIX #16: guard against zero division
    returns.push(closes[i - 1] !== 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0)
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
  // FIX #14: return capped Sortino instead of magic 99
  if (downside.length === 0) return avg > 0 ? Math.min(avg / 0.001 * Math.sqrt(252), 10) : 0
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
  if (past === 0) return null
  return (recent - past) / past
}

// ─── Regime Detection ────────────────────────────────────────

function detectRegime(
  adx: ADXResult | null,
  sma50Val: number | null,
  sma200Val: number | null,
  volatility20d: number | null,
  price: number
): TradingRecommendation['regime'] {
  const isTrending = adx && adx.adx > 25
  const isVolatile = volatility20d !== null && volatility20d > 0.35

  if (isVolatile && (!isTrending)) return 'volatile'
  if (isTrending && adx!.plusDI > adx!.minusDI) return 'trending_up'
  if (isTrending && adx!.minusDI > adx!.plusDI) return 'trending_down'
  if (sma50Val && sma200Val) {
    const range = Math.abs(price - sma50Val) / price
    if (range < 0.03) return 'ranging'
  }
  if (adx && adx.adx < 20) return 'ranging'
  return 'unknown'
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
          name: 'golden_cross', type: 'bullish', strength: 0.85,
          description: 'SMA 50 crossed above SMA 200 (Golden Cross)',
        })
      } else if (prev50 > prev200 && sma50Val < sma200Val) {
        patterns.push({
          name: 'death_cross', type: 'bearish', strength: 0.85,
          description: 'SMA 50 crossed below SMA 200 (Death Cross)',
        })
      }
    }

    if (price > sma50Val && sma50Val > sma200Val) {
      patterns.push({
        name: 'uptrend', type: 'bullish', strength: 0.60,
        description: 'Price above SMA 50 above SMA 200 — established uptrend',
      })
    } else if (price < sma50Val && sma50Val < sma200Val) {
      patterns.push({
        name: 'downtrend', type: 'bearish', strength: 0.60,
        description: 'Price below SMA 50 below SMA 200 — established downtrend',
      })
    }
  }

  // MACD crossover + divergence (FIX #10 + #11)
  if (macd && macd.series.length >= 2) {
    const prev = macd.series[macd.series.length - 2]
    const curr = macd.series[macd.series.length - 1]
    if (prev.histogram < 0 && curr.histogram > 0) {
      patterns.push({
        name: 'macd_bullish_cross', type: 'bullish', strength: 0.70,
        description: 'MACD line crossed above signal line',
      })
    } else if (prev.histogram > 0 && curr.histogram < 0) {
      patterns.push({
        name: 'macd_bearish_cross', type: 'bearish', strength: 0.70,
        description: 'MACD line crossed below signal line',
      })
    }

    // FIX #10+#11: Both bearish AND bullish divergence with safe array access
    if (closes.length >= 40 && macd.series.length >= 40) {
      const recentCloses = closes.slice(-20)
      const olderCloses = closes.slice(-40, -20)
      const recentMACDs = macd.series.slice(-20).map((s) => s.macd)
      const olderMACDs = macd.series.slice(-40, -20).map((s) => s.macd)

      if (recentMACDs.length > 0 && olderMACDs.length > 0) {
        const recentPriceHigh = Math.max(...recentCloses)
        const olderPriceHigh = Math.max(...olderCloses)
        const recentMACDHigh = Math.max(...recentMACDs)
        const olderMACDHigh = Math.max(...olderMACDs)

        // Bearish divergence: price higher high, MACD lower high
        if (recentPriceHigh > olderPriceHigh && recentMACDHigh < olderMACDHigh) {
          patterns.push({
            name: 'bearish_divergence', type: 'bearish', strength: 0.75,
            description: 'Price making higher high but MACD is lower — bearish divergence',
          })
        }

        // Bullish divergence: price lower low, MACD higher low
        const recentPriceLow = Math.min(...recentCloses)
        const olderPriceLow = Math.min(...olderCloses)
        const recentMACDLow = Math.min(...recentMACDs)
        const olderMACDLow = Math.min(...olderMACDs)

        if (recentPriceLow < olderPriceLow && recentMACDLow > olderMACDLow) {
          patterns.push({
            name: 'bullish_divergence', type: 'bullish', strength: 0.75,
            description: 'Price making lower low but MACD is higher — bullish divergence',
          })
        }
      }
    }
  }

  // RSI signals
  if (rsi !== null) {
    if (rsi < 30) {
      patterns.push({
        name: 'rsi_oversold', type: 'bullish',
        strength: Math.min(0.90, 0.60 + (30 - rsi) / 30 * 0.30),
        description: `RSI at ${rsi.toFixed(1)} — oversold territory`,
      })
    } else if (rsi > 70) {
      patterns.push({
        name: 'rsi_overbought', type: 'bearish',
        strength: Math.min(0.90, 0.60 + (rsi - 70) / 30 * 0.30),
        description: `RSI at ${rsi.toFixed(1)} — overbought territory`,
      })
    }
  }

  // Bollinger Band signals
  if (bb) {
    if (bb.percentB > 1) {
      patterns.push({
        name: 'bb_upper_breakout', type: 'bearish', strength: 0.65,
        description: 'Price above upper Bollinger Band — potential overbought',
      })
    } else if (bb.percentB < 0) {
      patterns.push({
        name: 'bb_lower_breakout', type: 'bullish', strength: 0.65,
        description: 'Price below lower Bollinger Band — potential oversold',
      })
    }

    if (bb.series.length >= 20) {
      const widths = bb.series.slice(-20).map((s) => s.middle !== 0 ? (s.upper - s.lower) / s.middle : 0)
      const avgWidth = mean(widths)
      if (bb.width < avgWidth * 0.6) {
        patterns.push({
          name: 'bb_squeeze', type: 'neutral', strength: 0.70,
          description: 'Bollinger Band squeeze — volatility contraction, breakout imminent',
        })
      }
    }
  }

  // Volume spike
  if (volumeRatio !== null && volumeRatio > 2.0) {
    patterns.push({
      name: 'volume_spike', type: 'neutral',
      strength: Math.min(0.80, 0.50 + (volumeRatio - 2) * 0.15),
      description: `Volume ${volumeRatio.toFixed(1)}x above 20-day average — unusual activity`,
    })
  }

  // ADX trend strength
  if (adx) {
    if (adx.adx > 25 && adx.plusDI > adx.minusDI) {
      patterns.push({
        name: 'strong_uptrend_adx', type: 'bullish',
        strength: Math.min(0.85, 0.40 + adx.adx / 100),
        description: `ADX ${adx.adx.toFixed(1)} with +DI > -DI — strong uptrend`,
      })
    } else if (adx.adx > 25 && adx.minusDI > adx.plusDI) {
      patterns.push({
        name: 'strong_downtrend_adx', type: 'bearish',
        strength: Math.min(0.85, 0.40 + adx.adx / 100),
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
        name: 'stoch_bullish_cross', type: 'bullish', strength: 0.65,
        description: 'Stochastic %K crossed above %D in oversold zone',
      })
    } else if (prev.k > prev.d && curr.k < curr.d && curr.k > 80) {
      patterns.push({
        name: 'stoch_bearish_cross', type: 'bearish', strength: 0.65,
        description: 'Stochastic %K crossed below %D in overbought zone',
      })
    }
  }

  return patterns
}

// ─── Unified Composite Score ─────────────────────────────────
// Weights: Technical 65%, Sentiment 20%, Risk/Fundamentals 15%

interface CompositeInput {
  rsi: number | null
  macd: MACDResult | null
  bb: BollingerResult | null
  sma20: number | null
  sma50: number | null
  sma200: number | null
  adx: ADXResult | null
  stoch: StochasticResult | null
  volumeRatio: number | null
  return20d: number | null
  sharpe: number | null
  beta: number | null
  pe: number | null
  price: number
  patterns: PatternSignal[]
  sentiment: SentimentData | null
  fiftyTwoWeekHigh: number | null
  fiftyTwoWeekLow: number | null
  regime: TradingRecommendation['regime']
  /** Instrument class — crypto skips stock-specific components (P/E, beta, 52w). */
  secType?: string | null
}

/**
 * Present-component coverage (0-1). The composite divides by the weights
 * of PRESENT components only, so scores of thin-data tickers are not
 * comparable to full-data ones — coverage makes that explicit and lets
 * the screener filter for it.
 */
export function compositeCoverage(input: CompositeInput): number {
  const empty: ScoreBreakdown = {
    rsi: 0, macd: 0, bollingerBands: 0, trend: 0, adx: 0, stochastic: 0,
    momentum: 0, volume: 0, patterns: 0,
    sentiment: 0, sentimentMomentum: 0, newsVolume: 0,
    sharpe: 0, beta: 0, pe: 0, fiftyTwoWeek: 0,
  }
  return scoreFromBreakdown(empty, QUANT_DEFAULT_WEIGHTS, presenceFor(input)).coverage
}

// ─── Composite weights ─────────────────────────────────────────
//
// Default weights are the shipped heuristic. quant:sweep re-scores cached
// validation rows under alternative weight sets and can replace these with
// the evidence-backed ones (quant:validate showed the defaults rank
// INVERTED at the 20d horizon — trend/momentum/sharpe carry negative IC).

export interface QuantWeights {
  rsi: number; macd: number; bollingerBands: number; trend: number; adx: number
  stochastic: number; momentum: number; volume: number; patterns: number
  sentiment: number; sentimentMomentum: number; newsVolume: number
  sharpe: number; beta: number; pe: number; fiftyTwoWeek: number
}

export const QUANT_DEFAULT_WEIGHTS: QuantWeights = {
  rsi: 10, macd: 10, bollingerBands: 7, trend: 10, adx: 7, stochastic: 5,
  momentum: 8, volume: 4, patterns: 4,
  sentiment: 12, sentimentMomentum: 5, newsVolume: 3,
  sharpe: 4, beta: 3, pe: 4, fiftyTwoWeek: 4,
}

/**
 * Crypto weights — evidence-driven from quant:validate on Kraken daily
 * data (10 crypto symbols, 5d step, 20d forward): macd (+0.076) and
 * momentum (+0.021) carry the only positive ICs; trend/rsi/stochastic/
 * bollinger/sharpe are anti-signals on crypto (mean-reversion fights the
 * momentum factor). Sentiment stays (sparse coverage, neutral IC).
 */
export function cryptoWeights(_w: QuantWeights): QuantWeights {
  return {
    rsi: 0, macd: 20, bollingerBands: 0, trend: 0, adx: 0, stochastic: 0,
    momentum: 15, volume: 8, patterns: 0,
    sentiment: 16, sentimentMomentum: 5, newsVolume: 5,
    sharpe: 0, beta: 0, pe: 0, fiftyTwoWeek: 0,
  }
}

/**
 * Weighted composite from a breakdown. Mirrors computeCompositeScore's
 * math: only PRESENT components count toward numerator AND denominator —
 * a thin-data ticker scores on the same basis as a full one. Presence is
 * the compositeCoverage list evaluated per component.
 */
export function scoreFromBreakdown(
  breakdown: ScoreBreakdown,
  weights: QuantWeights,
  present: Record<string, boolean>
): { score: number; coverage: number } {
  const keys = Object.keys(weights) as Array<keyof QuantWeights>
  let score = 0
  let weightSum = 0
  let presentCount = 0
  for (const key of keys) {
    const w = weights[key]
    if (w <= 0) continue
    if (present[key] === false) continue
    presentCount++
    score += breakdown[key] * w
    weightSum += w
  }
  return {
    score: weightSum > 0 ? Math.round(score / weightSum) : 0,
    coverage: presentCount / keys.length,
  }
}

function computeCompositeScore(input: CompositeInput): { score: number; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = {
    rsi: 0, macd: 0, bollingerBands: 0, trend: 0, adx: 0, stochastic: 0,
    momentum: 0, volume: 0, patterns: 0,
    sentiment: 0, sentimentMomentum: 0, newsVolume: 0,
    sharpe: 0, beta: 0, pe: 0, fiftyTwoWeek: 0,
  }

  // Instrument-class weights: crypto has no P/E/beta-vs-SPY/52-week
  // meaning, so those weight points shift to momentum, volume and
  // sentiment (the signals that do move crypto).
  const w = input.secType === 'crypto'
    ? cryptoWeights(QUANT_DEFAULT_WEIGHTS)
    : QUANT_DEFAULT_WEIGHTS

  // ── Technical ──

  // RSI — graded scoring instead of linear from center. Regime-aware:
  // oversold in a downtrend is a falling knife, not a contrarian buy;
  // overbought in a downtrend carries no long signal.
  if (input.rsi !== null) {
    let rsiScore: number
    const down = input.regime === 'trending_down'
    if (down && input.rsi <= 30) rsiScore = -50 - ((30 - input.rsi) / 30) * 50
    else if (down && input.rsi >= 70) rsiScore = 0
    else if (input.rsi <= 30) rsiScore = 50 + ((30 - input.rsi) / 30) * 50
    else if (input.rsi >= 70) rsiScore = -50 - ((input.rsi - 70) / 30) * 50
    else if (input.rsi < 45) rsiScore = ((45 - input.rsi) / 15) * 50
    else if (input.rsi > 55) rsiScore = -((input.rsi - 55) / 15) * 50
    else rsiScore = 0 // 45-55 is dead zone (neutral)
    breakdown.rsi = Math.max(-100, Math.min(100, rsiScore))
  }

  // MACD — price-normalized histogram
  if (input.macd && input.price > 0) {
    const normalizedHist = (input.macd.histogram / input.price) * 100
    breakdown.macd = Math.max(-100, Math.min(100, normalizedHist * 200))
  }

  // Bollinger %B
  if (input.bb) {
    breakdown.bollingerBands = Math.max(-100, Math.min(100, (0.5 - input.bb.percentB) * 200))
  }

  // Trend alignment
  if (input.sma20 && input.sma50 && input.sma200 && input.price > 0) {
    let trendScore = 0
    if (input.price > input.sma20) trendScore += 33
    else trendScore -= 33
    if (input.sma20 > input.sma50) trendScore += 33
    else trendScore -= 33
    if (input.sma50 > input.sma200) trendScore += 34
    else trendScore -= 34
    breakdown.trend = trendScore
  }

  // ADX directional
  if (input.adx && input.adx.adx > 20) {
    breakdown.adx = input.adx.plusDI > input.adx.minusDI
      ? Math.min(100, (input.adx.plusDI - input.adx.minusDI) * 3)
      : Math.max(-100, (input.adx.plusDI - input.adx.minusDI) * 3)
  }

  // Stochastic — graded like RSI, regime-aware like RSI
  if (input.stoch) {
    let stochScore: number
    const down = input.regime === 'trending_down'
    if (down && input.stoch.k <= 20) stochScore = -50 - ((20 - input.stoch.k) / 20) * 50
    else if (down && input.stoch.k >= 80) stochScore = 0
    else if (input.stoch.k <= 20) stochScore = 50 + ((20 - input.stoch.k) / 20) * 50
    else if (input.stoch.k >= 80) stochScore = -50 - ((input.stoch.k - 80) / 20) * 50
    else if (input.stoch.k < 40) stochScore = ((40 - input.stoch.k) / 20) * 50
    else if (input.stoch.k > 60) stochScore = -((input.stoch.k - 60) / 20) * 50
    else stochScore = 0
    breakdown.stochastic = Math.max(-100, Math.min(100, stochScore))
  }

  // Momentum
  if (input.return20d !== null) {
    breakdown.momentum = Math.max(-100, Math.min(100, input.return20d * 500))
  }

  // Volume confirmation — direction-aware with gradient
  if (input.volumeRatio !== null && input.return20d !== null) {
    let volScore: number
    if (input.return20d > 0) {
      volScore = input.volumeRatio > 1.0 ? Math.min(100, (input.volumeRatio - 1) * 100) : -20
    } else if (input.return20d < 0) {
      volScore = input.volumeRatio > 1.0 ? Math.max(-100, -(input.volumeRatio - 1) * 100) : 20
    } else {
      volScore = 0
    }
    breakdown.volume = volScore
  }

  // Patterns
  if (input.patterns.length > 0) {
    let patternScore = 0
    let patternWeight = 0
    for (const p of input.patterns) {
      const direction = p.type === 'bullish' ? 1 : p.type === 'bearish' ? -1 : 0
      patternScore += direction * p.strength * 100
      patternWeight += p.strength
    }
    if (patternWeight > 0) {
      breakdown.patterns = Math.max(-100, Math.min(100, patternScore / patternWeight))
    }
  }

  // ── Sentiment ──

  if (input.sentiment) {
    if (input.sentiment.totalArticles > 0) {
      breakdown.sentiment = Math.max(-100, Math.min(100, input.sentiment.avgScore * 100))

      // Sentiment momentum — require minimum articles
      if (input.sentiment.totalArticles >= 3) {
        breakdown.sentimentMomentum = Math.max(-100, Math.min(100, input.sentiment.recentTrend * 200))
      }

      // News volume — bidirectional
      const volumeBase = Math.min(100, Math.log2(input.sentiment.totalArticles + 1) * 20)
      const sentimentSign = input.sentiment.avgScore >= 0 ? 1 : -1
      breakdown.newsVolume = volumeBase * sentimentSign
    }
  }

  // ── Risk/Fundamentals (stocks/ETFs only — crypto weights are 0) ──

  if (input.sharpe !== null) {
    breakdown.sharpe = Math.max(-100, Math.min(100, input.sharpe * 40))
  }

  if (input.beta !== null) {
    let betaScore: number
    if (input.regime === 'trending_up') {
      betaScore = input.beta > 1.2 ? 20 : input.beta < 0.8 ? -20 : 0
    } else if (input.regime === 'trending_down' || input.regime === 'volatile') {
      betaScore = input.beta < 0.8 ? 30 : input.beta > 1.3 ? -40 : 0
    } else {
      betaScore = 0
    }
    breakdown.beta = betaScore
  }

  if (input.pe !== null && input.pe > 0) {
    const peScore = input.pe < 15 ? 60 : input.pe < 25 ? 20 : input.pe < 40 ? -20 : -60
    breakdown.pe = peScore
  }

  if (input.fiftyTwoWeekHigh && input.fiftyTwoWeekLow && input.price > 0) {
    const range = input.fiftyTwoWeekHigh - input.fiftyTwoWeekLow
    if (range > 0) {
      const position = (input.price - input.fiftyTwoWeekLow) / range
      let posScore: number
      if (input.regime === 'trending_up') {
        posScore = position > 0.8 ? 10 : position < 0.3 ? -30 : 0
      } else {
        if (position <= 0.3) posScore = 50 + ((0.3 - position) / 0.3) * 50
        else if (position >= 0.7) posScore = -((position - 0.7) / 0.3) * 60
        else posScore = 0
      }
      breakdown.fiftyTwoWeek = Math.max(-100, Math.min(100, posScore))
    }
  }

  const { score } = scoreFromBreakdown(breakdown, w, presenceFor(input))
  return { score, breakdown }
}

/**
 * Which composite components had data at this point in time — the presence
 * mask used by scoreFromBreakdown (missing = excluded from numerator AND
 * denominator, so thin-data tickers stay comparable).
 */
function presenceFor(input: CompositeInput): Record<string, boolean> {
  return {
    rsi: input.rsi !== null,
    macd: input.macd !== null,
    bollingerBands: input.bb !== null,
    trend: input.sma20 !== null && input.sma50 !== null && input.sma200 !== null,
    adx: input.adx !== null,
    stochastic: input.stoch !== null,
    momentum: input.return20d !== null,
    volume: input.volumeRatio !== null && input.return20d !== null,
    patterns: input.patterns.length > 0,
    sentiment: !!input.sentiment && input.sentiment.totalArticles > 0,
    sentimentMomentum: !!input.sentiment && input.sentiment.totalArticles >= 3,
    newsVolume: !!input.sentiment && input.sentiment.totalArticles > 0,
    sharpe: input.sharpe !== null,
    beta: input.beta !== null,
    pe: input.pe !== null && input.pe > 0,
    fiftyTwoWeek: input.fiftyTwoWeekHigh !== null && input.fiftyTwoWeekLow !== null,
  }
}

function classifySignal(score: number): TickerAnalysis['quantSignal'] {
  if (score >= 40) return 'strong_buy'
  if (score >= 15) return 'buy'
  if (score <= -40) return 'strong_sell'
  if (score <= -15) return 'sell'
  return 'neutral'
}

// ─── Pure indicator snapshot ───────────────────────────────────
//
// Everything analyzeTickerData computes from a bar series, as a pure
// function of the bars + context. The production analysis and the
// quant:validate harness share this path — validation measures THE
// production scoring, not a copy.

interface IndicatorSnapshot {
  closes: number[]
  volumes: number[]
  returns: number[]
  price: number
  sma20: number | null
  sma50: number | null
  sma200: number | null
  ema12: number | null
  ema26: number | null
  rsi14: number | null
  macd: MACDResult | null
  stochastic: StochasticResult | null
  adx: ADXResult | null
  bollingerBands: BollingerResult | null
  atr14: number | null
  volatility20d: number | null
  volatility60d: number | null
  obv: number
  obvTrend: 'rising' | 'falling' | 'flat' | null
  volumeSma20: number | null
  volumeRatio: number | null
  beta: number | null
  sharpe: number | null
  sortino: number | null
  maxDrawdown: number | null
  regime: ReturnType<typeof detectRegime>
  patterns: PatternSignal[]
  return20d: number | null
  compositeScore: number
  breakdown: ScoreBreakdown
  coverage: number
  /** Component presence mask (used by quant:sweep re-scoring). */
  present: Record<string, boolean>
}

export function computeIndicatorSnapshot(
  bars: Bar[],
  opts: { spyReturns?: number[]; meta?: any; sentiment?: SentimentData; secType?: string | null }
): IndicatorSnapshot {
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

  let obvTrend: 'rising' | 'falling' | 'flat' | null = null
  if (obvResult.series.length >= 20) {
    const recentOBV = obvResult.series.slice(-20)
    const first5 = mean(recentOBV.slice(0, 5))
    const last5 = mean(recentOBV.slice(-5))
    const diff = (last5 - first5) / (Math.abs(first5) || 1)
    obvTrend = diff > 0.05 ? 'rising' : diff < -0.05 ? 'falling' : 'flat'
  }

  // Returns & risk
  const spyReturns = opts.spyReturns || []
  const betaVal = computeBeta(returns, spyReturns)
  const sharpe = computeSharpe(returns)
  const sortino = computeSortino(returns)
  const maxDD = computeMaxDrawdown(closes)

  // Fundamentals (static metadata — point-in-time for validation purposes)
  const meta = (opts.meta || {}) as any

  // Sentiment (already computed point-in-time by the caller)
  const sentiment = opts.sentiment || { totalArticles: 0, avgScore: 0, recentTrend: 0 }

  // Regime detection
  const regime = detectRegime(adxResult, sma50, sma200, vol20d, price)

  // Patterns
  const patterns = detectPatterns(
    bars, closes, rsi14, macdResult, bbResult, sma50, sma200, adxResult, volumeRatio
  )

  // Unified composite score
  const return20d = priceChange(closes, 20)
  const compositeInput = {
    rsi: rsi14, macd: macdResult, bb: bbResult,
    sma20, sma50, sma200, adx: adxResult, stoch: stochResult,
    volumeRatio, return20d, sharpe, beta: betaVal, pe: Number(meta.pe) || null, price,
    patterns, sentiment,
    fiftyTwoWeekHigh: Number(meta.fiftyTwoWeekHigh) || null,
    fiftyTwoWeekLow: Number(meta.fiftyTwoWeekLow) || null,
    regime,
    secType: opts.secType ?? meta.secType ?? null,
  }
  const { score: compositeScore, breakdown } = computeCompositeScore(compositeInput)

  return {
    closes, volumes, returns, price,
    sma20, sma50, sma200, ema12: ema12Val, ema26: ema26Val,
    rsi14, macd: macdResult, stochastic: stochResult, adx: adxResult,
    bollingerBands: bbResult, atr14, volatility20d: vol20d, volatility60d: vol60d,
    obv: obvResult.obv, obvTrend, volumeSma20, volumeRatio,
    beta: betaVal, sharpe, sortino, maxDrawdown: maxDD,
    regime, patterns, return20d,
    compositeScore, breakdown,
    coverage: compositeCoverage(compositeInput),
    present: presenceFor(compositeInput),
  }
}

// ─── Conviction & Recommendation ─────────────────────────────

function computeConviction(breakdown: ScoreBreakdown, score: number): number {
  // FIX #12: conviction = how many indicators agree on direction
  const components = [
    breakdown.rsi, breakdown.macd, breakdown.bollingerBands, breakdown.trend,
    breakdown.adx, breakdown.stochastic, breakdown.momentum, breakdown.volume,
    breakdown.sentiment, breakdown.sentimentMomentum, breakdown.patterns,
  ]

  const signedComponents = components.filter((c) => c !== 0)
  if (signedComponents.length === 0) return 0

  const scoreSign = score >= 0 ? 1 : -1
  const agreeing = signedComponents.filter((c) => Math.sign(c) === scoreSign).length
  const agreement = agreeing / signedComponents.length

  // Scale by score magnitude
  const magnitude = Math.min(1, Math.abs(score) / 60)

  return Math.round(agreement * magnitude * 100) / 100
}

function computeRecommendation(
  score: number,
  conviction: number,
  regime: TradingRecommendation['regime'],
  price: number,
  atr14: number | null,
  beta: number | null
): TradingRecommendation {
  // Action
  let action: TradingRecommendation['action']
  if (score >= 40 && conviction >= 0.5) action = 'strong_buy'
  else if (score >= 15) action = 'buy'
  else if (score <= -40 && conviction >= 0.5) action = 'strong_sell'
  else if (score <= -15) action = 'sell'
  else action = 'hold'

  // Position sizing: Kelly-inspired with conviction and beta adjustment
  let positionSize = 0
  if (action !== 'hold') {
    const baseSize = Math.min(0.15, conviction * 0.2)
    const betaAdj = beta !== null ? 1 / Math.max(0.5, beta) : 1
    positionSize = Math.round(Math.min(0.20, baseSize * betaAdj) * 100) / 100
  }

  // Stop loss and take profit (ATR-based)
  let stopLoss: number | null = null
  let takeProfit: number | null = null
  let riskRewardRatio: number | null = null

  if (atr14 && price > 0 && action !== 'hold') {
    const isBuy = action === 'buy' || action === 'strong_buy'
    const multiplier = regime === 'volatile' ? 2.5 : 2.0
    const stopDist = atr14 * multiplier
    const profitDist = atr14 * multiplier * 2.0

    if (isBuy) {
      stopLoss = Math.round((price - stopDist) * 100) / 100
      takeProfit = Math.round((price + profitDist) * 100) / 100
    } else {
      stopLoss = Math.round((price + stopDist) * 100) / 100
      takeProfit = Math.round((price - profitDist) * 100) / 100
    }

    riskRewardRatio = stopDist > 0 ? Math.round((profitDist / stopDist) * 100) / 100 : null
  }

  return { action, conviction, regime, positionSize, stopLoss, takeProfit, riskRewardRatio }
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

    const snapshots = await MeilisearchService.getSnapshotsForTicker(spy.id)

    // FIX #15: coerce with Number()
    const closes = snapshots.map((s: any) => Number(s.close)).filter(Boolean)
    const returns = computeReturns(closes)
    this.spyReturnsCache = { returns, cachedAt: Date.now() }
    return returns
  }

  private async getSentimentData(
    tickerId: number,
    days: number,
    preloaded?: any[]
  ): Promise<SentimentData> {
    // Sentiment is scored on a 30-day recency-decayed window (half-life
    // 7.5d), NOT the full technical-analysis window (365d) — old news must
    // not weigh like today's. Events are deduped by eventKey (the same
    // story from 5 sources = one vote). Shares the live algo's math
    // (NewsScore.newsWindowScore).
    const sentimentWindowSeconds = Math.min(days, 30) * 86400
    const momentumShiftSeconds = 7 * 86400

    const analyses =
      preloaded ?? (await MeilisearchService.getAnalysesForTicker(tickerId, new Date(Date.now() - days * 86400000).toISOString()))
    if (analyses.length === 0) {
      return { totalArticles: 0, avgScore: 0, recentTrend: 0 }
    }

    const now = Date.now()
    const events = analysesToNewsEvents(analyses)
    const current = newsWindowScore(events, now, sentimentWindowSeconds)
    const shifted = newsWindowScore(events, now - momentumShiftSeconds, sentimentWindowSeconds)

    return {
      totalArticles: current.events,
      avgScore: current.score ?? 0,
      recentTrend: current.score !== null && shifted.score !== null ? current.score - shifted.score : 0,
    }
  }

  public async analyzeTicker(symbol: string, options: { days?: number } = {}): Promise<TickerAnalysis | null> {
    const ticker = await Ticker.query()
      .where('symbol', symbol.toUpperCase())
      .where('is_active', true)
      .first()

    if (!ticker) return null

    const snapshots = await MeilisearchService.getSnapshotsForTicker(ticker.id)

    if (snapshots.length < 5) {
      logger.warn('[Quant] Insufficient data for %s (%d bars)', symbol, snapshots.length)
      return null
    }

    return this.analyzeTickerData(ticker, snapshots, options)
  }

  public async analyzeTickerData(
    ticker: Ticker,
    snapshots: any[],
    options: { days?: number; analyses?: any[] } = {}
  ): Promise<TickerAnalysis | null> {
    const days = options.days || 365

    const bars: Bar[] = snapshots.map((s) => ({
      date: s.date,
      open: Number(s.open || s.close) || 0,
      high: Number(s.high || s.close) || 0,
      low: Number(s.low || s.close) || 0,
      close: Number(s.close) || 0,
      volume: Number(s.volume) || 0,
    }))

    const spyReturns = await this.getSPYReturns()
    const meta = (ticker.metadata || {}) as any
    const pe = meta.pe ? Number(meta.pe) : null
    const eps = meta.eps ? Number(meta.eps) : null
    const dividendYield = meta.dividendYield ? Number(meta.dividendYield) : null
    const sentimentData = await this.getSentimentData(ticker.id, days, options.analyses)
    const snap = computeIndicatorSnapshot(bars, { spyReturns, meta, sentiment: sentimentData, secType: ticker.secType })

    const {
      closes, price, sma20, sma50, sma200, ema12: ema12Val, ema26: ema26Val,
      rsi14, macd: macdResult, stochastic: stochResult, adx: adxResult,
      bollingerBands: bbResult, atr14, volatility20d: vol20d, volatility60d: vol60d,
      obv: obvValue, obvTrend, volumeSma20, volumeRatio,
      beta: betaVal, sharpe, sortino, maxDrawdown: maxDD,
      regime, patterns, return20d, compositeScore, breakdown, coverage,
    } = snap

    // Conviction & recommendation
    const conviction = computeConviction(breakdown, compositeScore)
    const recommendation = computeRecommendation(
      compositeScore, conviction, regime, price, atr14, betaVal
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
      // Use the latest snapshot close (the same price the indicators are
      // computed on) rather than the MariaDB tickers.current_price, which is
      // only refreshed on the cron schedule and can be stale by up to 45 min.
      currentPrice: price > 0 ? price : ticker.currentPrice,
      dataPoints: bars.length,
      coverage,

      sma20, sma50, sma200,
      ema12: ema12Val, ema26: ema26Val,

      rsi14,
      macd: macdResult,
      stochastic: stochResult,
      adx: adxResult,

      bollingerBands: bbResult,
      atr14,
      volatility20d: vol20d,
      volatility60d: vol60d,

obv: obvValue,
      obvTrend,
      volumeSma20,
      volumeRatio,

      returnDaily: priceChange(closes, 1),
      return5d: priceChange(closes, 5),
      return20d,
      return60d: priceChange(closes, 60),
      return252d: priceChange(closes, 252),
      sharpeRatio: sharpe,
      sortinoRatio: sortino,
      maxDrawdown: maxDD,
      beta: betaVal,

      pe, eps, dividendYield,
      marketCap: ticker.marketCap,

      sentiment: sentimentData.totalArticles > 0 ? sentimentData : null,

      patterns,
      compositeScore,
      quantSignal: classifySignal(compositeScore),
      scoreBreakdown: breakdown,
      recommendation,
    }
  }

  // FIX #19: batch-optimized screener — preload SPY returns and all snapshots
  public async screener(options: { days?: number; minArticles?: number; minCoverage?: number } = {}): Promise<ScreenerResult> {
    const days = options.days || 365
    const minArticles = options.minArticles || 0
    const minCoverage = options.minCoverage || 0
    const tickers = await Ticker.query().where('is_active', true).orderBy('symbol')

    // Preload all snapshots in batch from Meilisearch
    const tickerIds = tickers.map((t) => t.id)
    const [allSnapshots, allAnalyses] = await Promise.all([
      MeilisearchService.getSnapshotsForTickers(tickerIds),
      MeilisearchService.getAnalysesForTickers(
        tickerIds,
        new Date(Date.now() - days * 86400000).toISOString()
      ),
    ])

    // Group snapshots by tickerId
    const snapshotsByTicker = new Map<number, any[]>()
    for (const s of allSnapshots) {
      const existing = snapshotsByTicker.get(s.tickerId) || []
      existing.push(s)
      snapshotsByTicker.set(s.tickerId, existing)
    }

    // Group analyses by tickerId (single batch query instead of one per ticker)
    const analysesByTicker = new Map<number, any[]>()
    for (const a of allAnalyses) {
      const existing = analysesByTicker.get(a.tickerId) || []
      existing.push(a)
      analysesByTicker.set(a.tickerId, existing)
    }

    // Preload SPY returns
    await this.getSPYReturns()

    const results: ScreenerResult['tickers'] = []

    // Analyze tickers with bounded concurrency: work is I/O-bound (Meilisearch
    // sentiment + local math), so sequential processing wastes latency.
    const CONCURRENCY = 6
    let cursor = 0
    const workerCount = Math.min(CONCURRENCY, tickers.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < tickers.length) {
        const ticker = tickers[cursor++]
        try {
          const tickerSnapshots = snapshotsByTicker.get(ticker.id) || []
          if (tickerSnapshots.length < 5) continue

          const analysis = await this.analyzeTickerData(ticker, tickerSnapshots, {
            days,
            analyses: analysesByTicker.get(ticker.id),
          })
          if (!analysis) continue
          if (minArticles > 0 && (analysis.sentiment?.totalArticles || 0) < minArticles) continue
          if (minCoverage > 0 && analysis.coverage < minCoverage) continue

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
            sentiment_score: analysis.sentiment ? Math.round(analysis.sentiment.avgScore * 1000) / 1000 : null,
            article_count: analysis.sentiment?.totalArticles || 0,
            composite_score: analysis.compositeScore,
            coverage: analysis.coverage,
            signal: analysis.quantSignal,
            conviction: analysis.recommendation.conviction,
            regime: analysis.recommendation.regime,
            patterns: analysis.patterns.map((p) => p.name),
          })
        } catch (err) {
          logger.warn('[Quant] Failed to analyze %s: %s', ticker.symbol, (err as Error).message)
        }
      }
    })
    await Promise.all(workers)

    results.sort((a, b) => b.composite_score - a.composite_score)

    return {
      generated_at: new Date().toISOString(),
      count: results.length,
      tickers: results,
    }
  }

  // Compatibility: generate signals in the old TradingSignalService format
  public async generateSignals(options: { days?: number; minArticles?: number } = {}) {
    const screenerResult = await this.screener(options)
    return screenerResult.tickers.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      exchange: null,
      currentPrice: t.price,
      marketCap: null,
      compositeScore: t.composite_score,
      signal: t.signal,
      breakdown: {
        sentiment: t.sentiment_score ? t.sentiment_score * 100 : 0,
        sentimentMomentum: 0,
        newsVolume: t.article_count > 0 ? Math.min(100, Math.log2(t.article_count + 1) * 20) : 0,
        priceMomentum: t.return20d ? Math.max(-100, Math.min(100, t.return20d * 500 / 100)) : 0,
        rsi: t.rsi14 !== null ? (t.rsi14 < 30 ? 50 : t.rsi14 > 70 ? -50 : 0) : 0,
        volatility: t.volatility20d ? (t.volatility20d < 10 ? 30 : t.volatility20d > 30 ? -30 : 0) : 0,
        volumeTrend: 0,
        fiftyTwoWeekPosition: 0,
        fundamentals: 0,
      },
      meta: {
        articleCount: t.article_count,
        avgSentiment: t.sentiment_score || 0,
        recentSentimentTrend: 0,
        priceChange7d: null,
        priceChange30d: t.return20d,
        rsiValue: t.rsi14,
        volatility30d: t.volatility20d ? t.volatility20d / 100 : null,
        pe: null,
        snapshotDays: 0,
      },
    }))
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
  detectRegime,
  computeConviction,
  computeRecommendation,
  mean,
  stddev,
  priceChange,
}

export default new QuantEngineService()
