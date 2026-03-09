import natural from 'natural'
import Logger from '@ioc:Adonis/Core/Logger'
import type { SentimentLabel } from 'App/Models/Analysis'

const analyzer = new natural.SentimentAnalyzer('English', natural.PorterStemmer, 'afinn')
const tokenizer = new natural.WordTokenizer()
const TfIdf = natural.TfIdf

const FINANCIAL_POSITIVE = [
  'surge', 'rally', 'gain', 'profit', 'growth', 'beat', 'exceed', 'upgrade',
  'outperform', 'buy', 'bullish', 'record', 'high', 'soar', 'boom', 'strong',
  'positive', 'optimistic', 'recovery', 'breakout', 'momentum', 'upside',
  'dividend', 'earnings', 'revenue', 'innovation', 'expansion', 'acquisition',
]

const FINANCIAL_NEGATIVE = [
  'crash', 'plunge', 'loss', 'decline', 'miss', 'downgrade', 'underperform',
  'sell', 'bearish', 'low', 'drop', 'slump', 'weak', 'negative', 'pessimistic',
  'recession', 'bankruptcy', 'default', 'layoff', 'lawsuit', 'investigation',
  'fraud', 'debt', 'risk', 'warning', 'concern', 'volatility', 'selloff',
]

interface SentimentResult {
  sentiment: SentimentLabel
  sentimentScore: number
  confidence: number
  keywords: string[]
  reasoning: string
}

class SentimentService {
  public analyze(text: string, tickerSymbol?: string): SentimentResult {
    const tokens = tokenizer.tokenize(text.toLowerCase()) || []

    // Base NLP sentiment
    const baseSentiment = analyzer.getSentiment(tokens)

    // Financial-specific scoring
    let financialScore = 0
    const matchedKeywords: string[] = []

    for (const token of tokens) {
      if (FINANCIAL_POSITIVE.includes(token)) {
        financialScore += 0.15
        matchedKeywords.push(`+${token}`)
      }
      if (FINANCIAL_NEGATIVE.includes(token)) {
        financialScore -= 0.15
        matchedKeywords.push(`-${token}`)
      }
    }

    // Weighted combination: 40% NLP base, 60% financial lexicon
    const combinedScore = (baseSentiment * 0.4) + (financialScore * 0.6)

    // Normalize to [-1, 1]
    const normalizedScore = Math.max(-1, Math.min(1, combinedScore))

    // Determine label
    const sentiment = this.scoreToLabel(normalizedScore)

    // Calculate confidence based on agreement and signal strength
    const signalStrength = Math.abs(normalizedScore)
    const keywordDensity = Math.min(matchedKeywords.length / Math.max(tokens.length, 1), 0.3) / 0.3
    const confidence = Math.min(0.95, (signalStrength * 0.6 + keywordDensity * 0.4))

    // Extract top keywords via TF-IDF
    const tfidf = new TfIdf()
    tfidf.addDocument(text)
    const topTerms: string[] = []
    tfidf.listTerms(0).slice(0, 10).forEach((item) => {
      topTerms.push(item.term)
    })

    const allKeywords = [...new Set([...matchedKeywords, ...topTerms])].slice(0, 15)

    const reasoning = this.generateReasoning(sentiment, normalizedScore, matchedKeywords, tickerSymbol)

    return {
      sentiment,
      sentimentScore: Number(normalizedScore.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      keywords: allKeywords,
      reasoning,
    }
  }

  public analyzeRelevance(text: string, tickerSymbol: string, tickerName: string): number {
    const lowerText = text.toLowerCase()
    const lowerSymbol = tickerSymbol.toLowerCase()
    const lowerName = tickerName.toLowerCase()

    let score = 0

    // Direct symbol mention
    const symbolRegex = new RegExp(`\\b${lowerSymbol}\\b`, 'g')
    const symbolMatches = (lowerText.match(symbolRegex) || []).length
    score += Math.min(symbolMatches * 0.2, 0.5)

    // Company name mention
    const nameParts = lowerName.split(/\s+/).filter((p) => p.length > 2)
    for (const part of nameParts) {
      if (lowerText.includes(part)) {
        score += 0.15
      }
    }

    // Full name match
    if (lowerText.includes(lowerName)) {
      score += 0.3
    }

    return Math.min(1, Number(score.toFixed(4)))
  }

  private scoreToLabel(score: number): SentimentLabel {
    if (score <= -0.5) return 'very_bearish'
    if (score <= -0.15) return 'bearish'
    if (score <= 0.15) return 'neutral'
    if (score <= 0.5) return 'bullish'
    return 'very_bullish'
  }

  private generateReasoning(
    sentiment: SentimentLabel,
    score: number,
    keywords: string[],
    tickerSymbol?: string,
  ): string {
    const positiveKw = keywords.filter((k) => k.startsWith('+')).map((k) => k.slice(1))
    const negativeKw = keywords.filter((k) => k.startsWith('-')).map((k) => k.slice(1))

    const parts: string[] = []
    parts.push(`Overall sentiment: ${sentiment} (score: ${score.toFixed(3)})`)

    if (tickerSymbol) {
      parts.push(`Analyzed in context of ${tickerSymbol}.`)
    }

    if (positiveKw.length > 0) {
      parts.push(`Positive signals: ${positiveKw.join(', ')}.`)
    }

    if (negativeKw.length > 0) {
      parts.push(`Negative signals: ${negativeKw.join(', ')}.`)
    }

    if (positiveKw.length === 0 && negativeKw.length === 0) {
      parts.push('No strong financial signals detected.')
    }

    return parts.join(' ')
  }
}

export default new SentimentService()
