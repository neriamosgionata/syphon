import natural from 'natural'
import type { SentimentLabel } from '#models/Analysis'

const nlpAnalyzer = new natural.SentimentAnalyzer('English', natural.PorterStemmer, 'afinn')
const tokenizer = new natural.WordTokenizer()
const stemmer = natural.PorterStemmer
const TfIdf = natural.TfIdf

// ---------------------------------------------------------------------------
// Weighted financial lexicons — variable weight by severity/strength
// ---------------------------------------------------------------------------

const POSITIVE_LEXICON: Record<string, number> = {
  // Very strong
  surge: 0.30, soar: 0.30, boom: 0.30, breakout: 0.30, skyrocket: 0.30,
  // Strong
  rally: 0.25, beat: 0.25, exceed: 0.25, upgrade: 0.25, outperform: 0.25,
  record: 0.20, acquisition: 0.20, rebound: 0.20,
  // Medium
  gain: 0.15, profit: 0.15, growth: 0.15, bullish: 0.15, strong: 0.15,
  recovery: 0.15, momentum: 0.15, expansion: 0.15, innovation: 0.15,
  upbeat: 0.15, grow: 0.12, rise: 0.12,
  earnings: 0.12, revenue: 0.12, dividend: 0.12,
  // Mild
  buy: 0.10, positive: 0.10, optimistic: 0.10, upside: 0.10,
  improve: 0.10, outpace: 0.10,
  high: 0.08, stable: 0.08,
}

const NEGATIVE_LEXICON: Record<string, number> = {
  // Very strong
  crash: 0.35, bankruptcy: 0.35, fraud: 0.35, insolvency: 0.35,
  plunge: 0.30, default: 0.30,
  // Strong
  selloff: 0.25, downgrade: 0.25, underperform: 0.25, layoff: 0.25,
  recession: 0.25, liquidation: 0.25,
  // Medium
  loss: 0.15, decline: 0.15, miss: 0.15, bearish: 0.15, slump: 0.15,
  weak: 0.15, lawsuit: 0.15, investigation: 0.15, warning: 0.15,
  restructuring: 0.15, writedown: 0.15, fall: 0.12, shrink: 0.12,
  debt: 0.12,
  // Mild
  sell: 0.10, negative: 0.10, pessimistic: 0.10, drop: 0.10, cut: 0.10,
  risk: 0.08, concern: 0.08, volatility: 0.08, low: 0.08,
}

// Pre-compute stemmed lexicons so inflections match (surging→surge, profits→profit)
const STEMMED_POS = new Map<string, { word: string; weight: number }>()
for (const [word, weight] of Object.entries(POSITIVE_LEXICON)) {
  STEMMED_POS.set(stemmer.stem(word), { word, weight })
}
const STEMMED_NEG = new Map<string, { word: string; weight: number }>()
for (const [word, weight] of Object.entries(NEGATIVE_LEXICON)) {
  STEMMED_NEG.set(stemmer.stem(word), { word, weight })
}

// ---------------------------------------------------------------------------
// Multi-word phrase lexicons (higher precision than single keywords)
// ---------------------------------------------------------------------------

const PHRASE_POSITIVE: Record<string, number> = {
  'beat estimates': 0.30, 'beat expectations': 0.30, 'exceeded expectations': 0.30,
  'raised guidance': 0.30, 'earnings beat': 0.30, 'revenue beat': 0.30,
  'above consensus': 0.25, 'record high': 0.25, 'all time high': 0.25,
  'strong earnings': 0.25, 'upgraded to buy': 0.25, 'record profit': 0.25,
  'record revenue': 0.25, 'record earnings': 0.25, 'price target raised': 0.25,
  'revenue growth': 0.20, 'profit growth': 0.20, 'margin expansion': 0.20,
  'strong demand': 0.20, 'positive outlook': 0.20, 'market rally': 0.20,
  'insider buying': 0.20, 'buy rating': 0.20, 'strong performance': 0.20,
  'positive momentum': 0.20, 'top line growth': 0.20, 'bottom line growth': 0.20,
}

const PHRASE_NEGATIVE: Record<string, number> = {
  'missed estimates': 0.30, 'missed expectations': 0.30, 'earnings miss': 0.30,
  'revenue miss': 0.30, 'record loss': 0.30, 'lowered guidance': 0.30,
  'below expectations': 0.25, 'record low': 0.25, 'all time low': 0.25,
  'weak earnings': 0.25, 'downgraded to sell': 0.25, 'debt default': 0.35,
  'price target cut': 0.25, 'going concern': 0.25, 'mass layoff': 0.25,
  'market crash': 0.25, 'credit downgrade': 0.25, 'profit warning': 0.25,
  'revenue decline': 0.20, 'margin compression': 0.20, 'weak demand': 0.20,
  'negative outlook': 0.20, 'revenue shortfall': 0.25, 'insider selling': 0.20,
  'sell rating': 0.20, 'negative momentum': 0.20, 'below consensus': 0.25,
}

// ---------------------------------------------------------------------------
// Negation
// ---------------------------------------------------------------------------

const NEGATORS = new Set([
  'not', 'no', 'never', 'neither', 'hardly', 'barely', 'scarcely',
  'without', 'fail', 'failed', 'fails', 'unable', 'lack', 'lacking',
  'cannot', 'wont', 'dont', 'isnt', 'wasnt', 'arent', 'werent',
  'hasnt', 'havent', 'hadnt', 'didnt', 'doesnt', 'shouldnt',
  'wouldnt', 'couldnt', 'mustnt',
])

const NEGATION_PHRASE_RE = /\b(not|no|never|hardly|barely|fail(?:ed|s)?|unable|without|lack(?:ing)?|neither)\s*$/i

// ---------------------------------------------------------------------------
// Relevance helpers
// ---------------------------------------------------------------------------

const AMBIGUOUS_SYMBOLS = new Set([
  'A', 'AI', 'AN', 'ALL', 'ARE', 'AT', 'BE', 'BIG', 'CAN',
  'FOR', 'GO', 'HAS', 'HE', 'IT', 'LOW', 'MAN', 'NOW',
  'ON', 'OR', 'OUT', 'RUN', 'SO', 'T', 'THE', 'TO', 'UP',
  'WAS', 'YOU', 'REAL', 'TRUE', 'GOOD', 'NEXT', 'FAST',
])

const NAME_STOP_WORDS = new Set([
  'inc', 'corp', 'corporation', 'ltd', 'limited', 'llc', 'plc',
  'group', 'holdings', 'company', 'co', 'the', 'of', 'and',
  'class', 'series',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TextInput = string | { title?: string; summary?: string; content?: string }

interface SentimentResult {
  sentiment: SentimentLabel
  sentimentScore: number
  confidence: number
  keywords: string[]
  reasoning: string
}

interface TokenScoreResult {
  rawScore: number
  keywords: string[]
  positiveKw: string[]
  negativeKw: string[]
  negatedKw: string[]
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SentimentService {
  /**
   * Expand contractions so negation words become explicit tokens.
   * "isn't" → "is not", "can't" → "cannot", etc.
   */
  private preprocess(text: string): string {
    return text
      .replace(/\bcan['\u2019]t\b/gi, 'cannot')
      .replace(/\bwon['\u2019]t\b/gi, 'will not')
      .replace(/\bshan['\u2019]t\b/gi, 'shall not')
      .replace(/n['\u2019]t\b/gi, ' not')
  }

  /**
   * Check if the token at `index` is preceded by a negation word
   * within a 3-token window.
   */
  private isNegated(tokens: string[], index: number): boolean {
    const start = Math.max(0, index - 3)
    for (let i = start; i < index; i++) {
      if (NEGATORS.has(tokens[i])) return true
    }
    return false
  }

  /**
   * Score tokens against the weighted financial lexicons using stemmed matching.
   * Returns a raw sum — caller normalizes by text length.
   */
  private scoreTokens(tokens: string[]): TokenScoreResult {
    let rawScore = 0
    const keywords: string[] = []
    const positiveKw: string[] = []
    const negativeKw: string[] = []
    const negatedKw: string[] = []

    for (let i = 0; i < tokens.length; i++) {
      const stem = stemmer.stem(tokens[i])
      const negated = this.isNegated(tokens, i)

      const pos = STEMMED_POS.get(stem)
      if (pos) {
        if (negated) {
          rawScore -= pos.weight * 0.5
          keywords.push(`-${pos.word}`)
          negatedKw.push(pos.word)
        } else {
          rawScore += pos.weight
          keywords.push(`+${pos.word}`)
          positiveKw.push(pos.word)
        }
        continue // don't double-match against negative lexicon
      }

      const neg = STEMMED_NEG.get(stem)
      if (neg) {
        if (negated) {
          rawScore += neg.weight * 0.5
          keywords.push(`+${neg.word}`)
          negatedKw.push(neg.word)
        } else {
          rawScore -= neg.weight
          keywords.push(`-${neg.word}`)
          negativeKw.push(neg.word)
        }
      }
    }

    return { rawScore, keywords, positiveKw, negativeKw, negatedKw }
  }

  /**
   * Score multi-word financial phrases. Checks for negation
   * in the 25 chars preceding each occurrence.
   */
  private scorePhrases(text: string): { score: number; keywords: string[] } {
    const lower = text.toLowerCase()
    let score = 0
    const keywords: string[] = []

    for (const [phrase, weight] of Object.entries(PHRASE_POSITIVE)) {
      let idx = lower.indexOf(phrase)
      while (idx !== -1) {
        const prefix = lower.slice(Math.max(0, idx - 25), idx)
        const negated = NEGATION_PHRASE_RE.test(prefix)
        score += negated ? -weight * 0.5 : weight
        keywords.push(negated ? `-"${phrase}"` : `+"${phrase}"`)
        idx = lower.indexOf(phrase, idx + phrase.length)
      }
    }

    for (const [phrase, weight] of Object.entries(PHRASE_NEGATIVE)) {
      let idx = lower.indexOf(phrase)
      while (idx !== -1) {
        const prefix = lower.slice(Math.max(0, idx - 25), idx)
        const negated = NEGATION_PHRASE_RE.test(prefix)
        score += negated ? weight * 0.5 : -weight
        keywords.push(negated ? `+"${phrase}"` : `-"${phrase}"`)
        idx = lower.indexOf(phrase, idx + phrase.length)
      }
    }

    return { score, keywords }
  }

  /**
   * Normalize a raw financial score by text length.
   * Uses log2(n+1) to dampen long texts without crushing short ones.
   */
  private normalizeByLength(rawScore: number, tokenCount: number): number {
    if (tokenCount === 0) return 0
    return rawScore / Math.log2(tokenCount + 1)
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  public analyze(input: TextInput, tickerSymbol?: string): SentimentResult {
    // Separate title (high-signal) from body text
    let titleText = ''
    let bodyText = ''

    if (typeof input === 'string') {
      bodyText = input
    } else {
      titleText = input.title || ''
      bodyText = [input.summary, input.content].filter(Boolean).join(' ')
    }

    titleText = this.preprocess(titleText)
    bodyText = this.preprocess(bodyText)

    const titleTokens = tokenizer.tokenize(titleText.toLowerCase()) || []
    const bodyTokens = tokenizer.tokenize(bodyText.toLowerCase()) || []
    const allTokens = [...titleTokens, ...bodyTokens]

    // Title gets 40% weight even though much shorter — amplifies headline signal
    const hasTitle = titleTokens.length > 0
    const titleWeight = hasTitle ? 0.4 : 0
    const bodyWeight = hasTitle ? 0.6 : 1.0

    // NLP base sentiment (AFINN, already length-normalized)
    const titleNlp = titleTokens.length > 0 ? nlpAnalyzer.getSentiment(titleTokens) : 0
    const bodyNlp = bodyTokens.length > 0 ? nlpAnalyzer.getSentiment(bodyTokens) : 0
    const nlpScore = titleNlp * titleWeight + bodyNlp * bodyWeight

    // Financial lexicon scoring (length-normalized via log2)
    const titleFin = this.scoreTokens(titleTokens)
    const bodyFin = this.scoreTokens(bodyTokens)
    const titleFinNorm = this.normalizeByLength(titleFin.rawScore, titleTokens.length)
    const bodyFinNorm = this.normalizeByLength(bodyFin.rawScore, bodyTokens.length)
    const finScore = titleFinNorm * titleWeight + bodyFinNorm * bodyWeight

    // Phrase scoring (on combined text)
    const fullText = [titleText, bodyText].filter(Boolean).join('. ')
    const phrases = this.scorePhrases(fullText)
    const phraseNorm = this.normalizeByLength(phrases.score, allTokens.length)

    // --- Weighted combination: 35% NLP, 50% financial lexicon, 15% phrases ---
    const combinedScore = (nlpScore * 0.35) + (finScore * 0.50) + (phraseNorm * 0.15)
    const normalizedScore = Math.max(-1, Math.min(1, combinedScore))

    const sentiment = this.scoreToLabel(normalizedScore)

    // --- Confidence ---
    const signalStrength = Math.abs(normalizedScore)
    const totalFinKw = titleFin.keywords.length + bodyFin.keywords.length
    const keywordDensity = Math.min(totalFinKw / Math.max(allTokens.length, 1), 0.25) / 0.25
    // NLP and financial lexicon agree on direction → higher confidence
    const nlpAndFinAgree = (nlpScore > 0 && finScore > 0) || (nlpScore < 0 && finScore < 0)
    const agreementBonus = nlpAndFinAgree ? 0.1 : 0
    // Multi-word phrases are higher-precision signals
    const phraseBonus = phrases.keywords.length > 0 ? 0.08 : 0

    const confidence = Math.min(0.95,
      signalStrength * 0.45 + keywordDensity * 0.25 + agreementBonus + phraseBonus
    )

    // --- TF-IDF keyword extraction ---
    const tfidf = new TfIdf()
    tfidf.addDocument(fullText)
    const topTerms = tfidf.listTerms(0).slice(0, 10).map((item) => item.term)

    const allFinKeywords = [...new Set([...titleFin.keywords, ...bodyFin.keywords, ...phrases.keywords])]
    const allKeywords = [...new Set([...allFinKeywords, ...topTerms])].slice(0, 15)

    // --- Reasoning ---
    const reasoning = this.generateReasoning(
      sentiment, normalizedScore,
      [...titleFin.positiveKw, ...bodyFin.positiveKw],
      [...titleFin.negativeKw, ...bodyFin.negativeKw],
      [...titleFin.negatedKw, ...bodyFin.negatedKw],
      phrases.keywords,
      tickerSymbol,
    )

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

    // Direct symbol mention — require uppercase for ambiguous short symbols
    if (AMBIGUOUS_SYMBOLS.has(tickerSymbol.toUpperCase())) {
      const upperRegex = new RegExp(`\\b${this.escapeRegex(tickerSymbol.toUpperCase())}\\b`, 'g')
      const upperMatches = (text.match(upperRegex) || []).length
      score += Math.min(upperMatches * 0.15, 0.3)
    } else {
      const symbolRegex = new RegExp(`\\b${this.escapeRegex(lowerSymbol)}\\b`, 'g')
      const symbolMatches = (lowerText.match(symbolRegex) || []).length
      score += Math.min(symbolMatches * 0.2, 0.5)
    }

    // Company name parts (excluding common suffixes like Inc, Corp, Ltd)
    const nameParts = lowerName.split(/\s+/).filter((p) => p.length > 2 && !NAME_STOP_WORDS.has(p))
    for (const part of nameParts) {
      if (lowerText.includes(part)) {
        score += 0.15
      }
    }

    // Full name match bonus (stripped of common suffixes)
    const cleanedName = lowerName
      .replace(/\s+(inc|corp|corporation|ltd|limited|llc|plc|co)\.?\s*$/i, '')
      .trim()
    if (cleanedName.length > 3 && lowerText.includes(cleanedName)) {
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
    positiveKw: string[],
    negativeKw: string[],
    negatedKw: string[],
    phraseKw: string[],
    tickerSymbol?: string,
  ): string {
    const parts: string[] = []
    parts.push(`Overall sentiment: ${sentiment} (score: ${score.toFixed(3)})`)

    if (tickerSymbol) {
      parts.push(`Analyzed in context of ${tickerSymbol}.`)
    }

    const uniquePos = [...new Set(positiveKw)]
    const uniqueNeg = [...new Set(negativeKw)]

    if (uniquePos.length > 0) {
      parts.push(`Positive signals: ${uniquePos.join(', ')}.`)
    }

    if (uniqueNeg.length > 0) {
      parts.push(`Negative signals: ${uniqueNeg.join(', ')}.`)
    }

    const uniqueNegated = [...new Set(negatedKw)]
    if (uniqueNegated.length > 0) {
      parts.push(`Negated terms: ${uniqueNegated.join(', ')}.`)
    }

    const uniquePhrases = [...new Set(phraseKw.map((p) => p.replace(/^[+-]/, '')))]
    if (uniquePhrases.length > 0) {
      parts.push(`Key phrases: ${uniquePhrases.join(', ')}.`)
    }

    if (uniquePos.length === 0 && uniqueNeg.length === 0 && uniquePhrases.length === 0) {
      parts.push('No strong financial signals detected.')
    }

    return parts.join(' ')
  }
}

export default new SentimentService()
