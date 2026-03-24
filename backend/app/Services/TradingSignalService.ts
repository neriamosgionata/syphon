import Database from '@ioc:Adonis/Lucid/Database'
import Logger from '@ioc:Adonis/Core/Logger'
import Ticker from 'App/Models/Ticker'

interface SignalBreakdown {
  sentiment: number
  sentimentMomentum: number
  newsVolume: number
  priceMomentum: number
  rsi: number
  volatility: number
  volumeTrend: number
  fiftyTwoWeekPosition: number
  fundamentals: number
}

export interface TickerSignal {
  symbol: string
  name: string
  exchange: string | null
  currentPrice: number | null
  marketCap: number | null
  compositeScore: number
  signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell'
  breakdown: SignalBreakdown
  meta: {
    articleCount: number
    avgSentiment: number
    recentSentimentTrend: number
    priceChange7d: number | null
    priceChange30d: number | null
    rsiValue: number | null
    volatility30d: number | null
    pe: number | null
    snapshotDays: number
  }
}

// Weights for composite score
const WEIGHTS = {
  sentiment: 0.20,
  sentimentMomentum: 0.10,
  newsVolume: 0.05,
  priceMomentum: 0.20,
  rsi: 0.10,
  volatility: 0.05,
  volumeTrend: 0.10,
  fiftyTwoWeekPosition: 0.10,
  fundamentals: 0.10,
}

class TradingSignalService {
  /**
   * Generate trading signals for all active tickers.
   * Returns a ranked list from best to worst opportunity.
   */
  public async generateSignals(options: { days?: number; minArticles?: number } = {}): Promise<TickerSignal[]> {
    const days = options.days || 30
    const minArticles = options.minArticles || 0

    const tickers = await Ticker.query().where('is_active', true)
    const signals: TickerSignal[] = []

    for (const ticker of tickers) {
      try {
        const signal = await this.scoreTicker(ticker, days)
        if (signal && signal.meta.articleCount >= minArticles) {
          signals.push(signal)
        }
      } catch (err) {
        Logger.warn('[TradingSignal] Failed to score %s: %s', ticker.symbol, err.message)
      }
    }

    // Sort by composite score descending (best opportunities first)
    signals.sort((a, b) => b.compositeScore - a.compositeScore)

    return signals
  }

  private async scoreTicker(ticker: Ticker, days: number): Promise<TickerSignal | null> {
    const [sentimentData, snapshots] = await Promise.all([
      this.getSentimentData(ticker.id, days),
      this.getSnapshots(ticker.id, days),
    ])

    const breakdown: SignalBreakdown = {
      sentiment: this.scoreSentiment(sentimentData),
      sentimentMomentum: this.scoreSentimentMomentum(sentimentData),
      newsVolume: this.scoreNewsVolume(sentimentData),
      priceMomentum: this.scorePriceMomentum(snapshots),
      rsi: this.scoreRSI(snapshots),
      volatility: this.scoreVolatility(snapshots),
      volumeTrend: this.scoreVolumeTrend(snapshots),
      fiftyTwoWeekPosition: this.score52WeekPosition(ticker),
      fundamentals: this.scoreFundamentals(ticker),
    }

    const compositeScore = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => {
      return sum + (breakdown[key as keyof SignalBreakdown] || 0) * weight
    }, 0)

    const rsiValue = this.calculateRSI(snapshots)
    const priceChanges = this.calculatePriceChanges(snapshots)

    return {
      symbol: ticker.symbol,
      name: ticker.name,
      exchange: ticker.exchange,
      currentPrice: ticker.currentPrice,
      marketCap: ticker.marketCap,
      compositeScore: Math.round(compositeScore * 100) / 100,
      signal: this.classifySignal(compositeScore),
      breakdown: Object.fromEntries(
        Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])
      ) as any,
      meta: {
        articleCount: sentimentData.totalArticles,
        avgSentiment: Math.round((sentimentData.avgScore || 0) * 1000) / 1000,
        recentSentimentTrend: Math.round((sentimentData.recentTrend || 0) * 1000) / 1000,
        priceChange7d: priceChanges.change7d,
        priceChange30d: priceChanges.change30d,
        rsiValue: rsiValue !== null ? Math.round(rsiValue * 100) / 100 : null,
        volatility30d: this.calculateVolatility(snapshots),
        pe: (ticker.metadata as any)?.pe || null,
        snapshotDays: snapshots.length,
      },
    }
  }

  // ─── Sentiment Scoring ───

  private async getSentimentData(tickerId: number, days: number) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const halfCutoff = new Date(Date.now() - (days / 2) * 86400000).toISOString()

    const [allRows] = await Database.rawQuery(
      `SELECT sentiment_score, relevance_score, confidence, created_at
       FROM analyses WHERE ticker_id = ? AND created_at >= ?
       ORDER BY created_at ASC`,
      [tickerId, cutoff]
    )

    const analyses = allRows as any[]
    if (analyses.length === 0) {
      return { totalArticles: 0, avgScore: 0, recentTrend: 0, analyses: [] }
    }

    // Weighted average: weight by relevance * confidence
    let weightedSum = 0
    let weightTotal = 0
    for (const a of analyses) {
      const w = (Number(a.relevance_score) || 0.5) * (Number(a.confidence) || 0.5)
      weightedSum += Number(a.sentiment_score) * w
      weightTotal += w
    }
    const avgScore = weightTotal > 0 ? weightedSum / weightTotal : 0

    // Recent trend: compare average sentiment of recent half vs older half
    const recent = analyses.filter((a) => a.created_at >= halfCutoff)
    const older = analyses.filter((a) => a.created_at < halfCutoff)

    let recentAvg = 0
    let olderAvg = 0
    if (recent.length > 0) {
      recentAvg = recent.reduce((s, a) => s + Number(a.sentiment_score), 0) / recent.length
    }
    if (older.length > 0) {
      olderAvg = older.reduce((s, a) => s + Number(a.sentiment_score), 0) / older.length
    }
    const recentTrend = recent.length > 0 && older.length > 0 ? recentAvg - olderAvg : 0

    return { totalArticles: analyses.length, avgScore, recentTrend, analyses }
  }

  /**
   * Score [-100, 100]: Maps weighted avg sentiment (-1 to 1) to score
   */
  private scoreSentiment(data: { avgScore: number }): number {
    return data.avgScore * 100
  }

  /**
   * Score [-100, 100]: Sentiment improving vs deteriorating
   */
  private scoreSentimentMomentum(data: { recentTrend: number }): number {
    return Math.max(-100, Math.min(100, data.recentTrend * 200))
  }

  /**
   * Score [0, 100]: More articles = more market attention = opportunity
   * Logarithmic scale: 1 article = ~15, 5 = ~50, 20+ = ~100
   */
  private scoreNewsVolume(data: { totalArticles: number }): number {
    if (data.totalArticles === 0) return 0
    return Math.min(100, Math.log2(data.totalArticles + 1) * 20)
  }

  // ─── Technical Scoring ───

  private async getSnapshots(tickerId: number, days: number) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
    const [rows] = await Database.rawQuery(
      `SELECT date, open, high, low, close, volume, change_percent
       FROM ticker_snapshots WHERE ticker_id = ? AND date >= ?
       ORDER BY date ASC`,
      [tickerId, cutoff]
    )
    return (rows as any[]) || []
  }

  /**
   * Score [-100, 100]: Price momentum over the period
   */
  private scorePriceMomentum(snapshots: any[]): number {
    if (snapshots.length < 5) return 0

    const recent = snapshots.slice(-5)
    const older = snapshots.slice(0, 5)
    const recentAvg = recent.reduce((s, r) => s + Number(r.close), 0) / recent.length
    const olderAvg = older.reduce((s, r) => s + Number(r.close), 0) / older.length

    if (olderAvg === 0) return 0
    const changePct = ((recentAvg - olderAvg) / olderAvg) * 100

    // Cap at ±30% movement → ±100 score
    return Math.max(-100, Math.min(100, (changePct / 30) * 100))
  }

  /**
   * RSI-based score [-100, 100]:
   * RSI < 30 = oversold (buy signal, positive score)
   * RSI > 70 = overbought (sell signal, negative score)
   * RSI 40-60 = neutral
   */
  private scoreRSI(snapshots: any[]): number {
    const rsi = this.calculateRSI(snapshots)
    if (rsi === null) return 0

    if (rsi <= 30) return 50 + ((30 - rsi) / 30) * 50       // 30→50, 0→100
    if (rsi >= 70) return -50 - ((rsi - 70) / 30) * 50      // 70→-50, 100→-100
    if (rsi < 50) return ((50 - rsi) / 20) * 50              // 50→0, 30→50
    return -((rsi - 50) / 20) * 50                            // 50→0, 70→-50
  }

  private calculateRSI(snapshots: any[], period = 14): number | null {
    if (snapshots.length < period + 1) return null

    const closes = snapshots.map((s) => Number(s.close))
    const changes = closes.slice(1).map((c, i) => c - closes[i])

    let avgGain = 0
    let avgLoss = 0
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i]
      else avgLoss += Math.abs(changes[i])
    }
    avgGain /= period
    avgLoss /= period

    // Smooth with Wilder's method
    for (let i = period; i < changes.length; i++) {
      if (changes[i] > 0) {
        avgGain = (avgGain * (period - 1) + changes[i]) / period
        avgLoss = (avgLoss * (period - 1)) / period
      } else {
        avgGain = (avgGain * (period - 1)) / period
        avgLoss = (avgLoss * (period - 1) + Math.abs(changes[i])) / period
      }
    }

    if (avgLoss === 0) return 100
    const rs = avgGain / avgLoss
    return 100 - 100 / (1 + rs)
  }

  /**
   * Score [-100, 100]: Lower volatility = higher positive score (safer)
   * Very high volatility can mean opportunity but also risk
   */
  private scoreVolatility(snapshots: any[]): number {
    const vol = this.calculateVolatility(snapshots)
    if (vol === null) return 0

    // < 1% daily vol = very stable → 50
    // 1-3% = moderate → 0 to 30
    // > 5% = high vol → -50 to -100
    if (vol < 0.01) return 50
    if (vol < 0.03) return 30 - ((vol - 0.01) / 0.02) * 30
    if (vol < 0.05) return -((vol - 0.03) / 0.02) * 50
    return Math.max(-100, -50 - ((vol - 0.05) / 0.05) * 50)
  }

  private calculateVolatility(snapshots: any[]): number | null {
    if (snapshots.length < 5) return null
    const returns = snapshots.slice(1).map((s, i) => {
      const prev = Number(snapshots[i].close)
      return prev > 0 ? (Number(s.close) - prev) / prev : 0
    })
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
    return Math.round(Math.sqrt(variance) * 10000) / 10000
  }

  /**
   * Score [-100, 100]: Increasing volume = bullish signal
   */
  private scoreVolumeTrend(snapshots: any[]): number {
    if (snapshots.length < 10) return 0

    const recentVol = snapshots.slice(-5).reduce((s, r) => s + (Number(r.volume) || 0), 0) / 5
    const olderVol = snapshots.slice(-10, -5).reduce((s, r) => s + (Number(r.volume) || 0), 0) / 5

    if (olderVol === 0) return 0
    const changeRatio = (recentVol - olderVol) / olderVol

    // ±50% volume change → ±100 score
    return Math.max(-100, Math.min(100, changeRatio * 200))
  }

  // ─── Position & Fundamentals ───

  /**
   * Score [-100, 100]: Position within 52-week range
   * Near low = buy opportunity (positive), near high = risky (negative)
   */
  private score52WeekPosition(ticker: Ticker): number {
    const meta = ticker.metadata as any
    if (!meta?.fiftyTwoWeekHigh || !meta?.fiftyTwoWeekLow || !ticker.currentPrice) return 0

    const high = Number(meta.fiftyTwoWeekHigh)
    const low = Number(meta.fiftyTwoWeekLow)
    if (high === low) return 0

    const position = (ticker.currentPrice - low) / (high - low) // 0 = at low, 1 = at high

    // Near the low (0-0.3) = buy signal (positive)
    // Mid range (0.3-0.7) = neutral
    // Near the high (0.7-1.0) = caution (slightly negative)
    if (position <= 0.3) return 50 + ((0.3 - position) / 0.3) * 50
    if (position >= 0.7) return -((position - 0.7) / 0.3) * 60
    return 0
  }

  /**
   * Score [-100, 100]: Basic fundamental assessment
   * Reasonable P/E = positive, extreme P/E = negative
   */
  private scoreFundamentals(ticker: Ticker): number {
    const meta = ticker.metadata as any
    if (!meta?.pe) return 0

    const pe = Number(meta.pe)
    if (pe <= 0) return -30 // Negative earnings

    // P/E 10-20 = good value → positive
    // P/E 20-35 = fair → neutral to slightly negative
    // P/E > 50 = overvalued → negative
    if (pe <= 10) return 60
    if (pe <= 20) return 40 - ((pe - 10) / 10) * 40
    if (pe <= 35) return -((pe - 20) / 15) * 30
    if (pe <= 50) return -30 - ((pe - 35) / 15) * 30
    return -60
  }

  // ─── Helpers ───

  private calculatePriceChanges(snapshots: any[]) {
    const result = { change7d: null as number | null, change30d: null as number | null }
    if (snapshots.length < 2) return result

    const latest = Number(snapshots[snapshots.length - 1].close)
    if (snapshots.length >= 5) {
      const ref7 = Number(snapshots[Math.max(0, snapshots.length - 6)].close)
      result.change7d = ref7 > 0 ? Math.round(((latest - ref7) / ref7) * 10000) / 100 : null
    }
    if (snapshots.length >= 20) {
      const ref30 = Number(snapshots[Math.max(0, snapshots.length - 21)].close)
      result.change30d = ref30 > 0 ? Math.round(((latest - ref30) / ref30) * 10000) / 100 : null
    }
    return result
  }

  private classifySignal(score: number): TickerSignal['signal'] {
    if (score >= 40) return 'strong_buy'
    if (score >= 15) return 'buy'
    if (score > -15) return 'neutral'
    if (score > -40) return 'sell'
    return 'strong_sell'
  }
}

export default new TradingSignalService()
