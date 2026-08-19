import { test } from '@japa/runner'
import SentimentService from '../../app/services/SentimentService.js'

/**
 * SentimentService unit tests
 * The service only depends on `natural` (pure JS lib) and the app logger
 * (booted by the test runner), so it can be imported directly.
 */

test.group('SentimentService', () => {
  test('analyze returns valid sentiment result structure', ({ assert }) => {
    const result = SentimentService.analyze('The stock market is showing strong growth and record profits')

    assert.properties(result, ['sentiment', 'sentimentScore', 'confidence', 'keywords', 'reasoning'])
    assert.isString(result.sentiment)
    assert.isNumber(result.sentimentScore)
    assert.isNumber(result.confidence)
    assert.isArray(result.keywords)
    assert.isString(result.reasoning)
  })

  test('analyze returns bullish sentiment for positive text', ({ assert }) => {
    const result = SentimentService.analyze(
      'Massive surge in stock price as profits beat expectations with strong growth and record revenue'
    )
    assert.isTrue(result.sentimentScore > 0)
    assert.include(['bullish', 'very_bullish'], result.sentiment)
  })

  test('analyze returns bearish sentiment for negative text', ({ assert }) => {
    const result = SentimentService.analyze(
      'Stock plunge amid recession fears as company reports massive loss and bankruptcy concerns with selloff'
    )
    assert.isTrue(result.sentimentScore < 0)
    assert.include(['bearish', 'very_bearish'], result.sentiment)
  })

  test('analyze returns neutral sentiment for neutral text', ({ assert }) => {
    const result = SentimentService.analyze(
      'The meeting was held on Tuesday to discuss standard quarterly procedures'
    )
    assert.include(['neutral', 'bullish', 'bearish'], result.sentiment)
    assert.isTrue(Math.abs(result.sentimentScore) < 0.5)
  })

  test('sentimentScore is normalized between -1 and 1', ({ assert }) => {
    const positiveResult = SentimentService.analyze(
      'surge rally gain profit growth beat exceed upgrade outperform buy bullish record soar boom strong'
    )
    const negativeResult = SentimentService.analyze(
      'crash plunge loss decline miss downgrade underperform sell bearish low drop slump weak negative'
    )

    assert.isTrue(positiveResult.sentimentScore >= -1 && positiveResult.sentimentScore <= 1)
    assert.isTrue(negativeResult.sentimentScore >= -1 && negativeResult.sentimentScore <= 1)
  })

  test('confidence is between 0 and 0.95', ({ assert }) => {
    const result = SentimentService.analyze('Strong profit growth and bullish momentum')
    assert.isTrue(result.confidence >= 0 && result.confidence <= 0.95)
  })

  test('keywords contain matched financial terms', ({ assert }) => {
    const result = SentimentService.analyze('The surge in profit and strong growth is notable')
    const keywordTexts = result.keywords.map((k: string) => k.replace(/^[+-]/, ''))
    assert.isTrue(keywordTexts.some((k: string) => ['surge', 'profit', 'growth', 'strong'].includes(k)))
  })

  test('reasoning includes sentiment label and score', ({ assert }) => {
    const result = SentimentService.analyze('Growth and profit are surging')
    assert.match(result.reasoning, /Overall sentiment:/)
    assert.match(result.reasoning, /score:/)
  })

  test('reasoning includes ticker context when provided', ({ assert }) => {
    const result = SentimentService.analyze('Growth is surging', 'AAPL')
    assert.match(result.reasoning, /AAPL/)
  })

  test('analyzeRelevance returns score for matching ticker symbol', ({ assert }) => {
    const score = SentimentService.analyzeRelevance(
      'AAPL reported strong earnings today. Apple Inc continues to innovate.',
      'AAPL',
      'Apple Inc'
    )
    assert.isTrue(score > 0)
    assert.isTrue(score <= 1)
  })

  test('analyzeRelevance returns 0 for non-matching ticker', ({ assert }) => {
    const score = SentimentService.analyzeRelevance(
      'The weather is nice today with clear skies',
      'MSFT',
      'Microsoft Corporation'
    )
    assert.equal(score, 0)
  })

  test('analyzeRelevance scores higher for full company name match', ({ assert }) => {
    const symbolOnly = SentimentService.analyzeRelevance(
      'AAPL had a good day',
      'AAPL',
      'Apple Inc'
    )
    const fullName = SentimentService.analyzeRelevance(
      'Apple Inc had a good day. AAPL stock is up.',
      'AAPL',
      'Apple Inc'
    )
    assert.isTrue(fullName > symbolOnly)
  })

  test('analyzeRelevance is case insensitive', ({ assert }) => {
    const score = SentimentService.analyzeRelevance(
      'aapl is doing well and apple inc is growing',
      'AAPL',
      'Apple Inc'
    )
    assert.isTrue(score > 0)
  })

  test('analyzeRelevance caps at 1.0', ({ assert }) => {
    const score = SentimentService.analyzeRelevance(
      'AAPL AAPL AAPL Apple Inc Apple Inc Apple Apple Apple apple',
      'AAPL',
      'Apple Inc'
    )
    assert.isTrue(score <= 1)
  })

  test('analyze handles empty string gracefully', ({ assert }) => {
    const result = SentimentService.analyze('')
    assert.properties(result, ['sentiment', 'sentimentScore', 'confidence', 'keywords', 'reasoning'])
    assert.include(['very_bearish', 'bearish', 'neutral', 'bullish', 'very_bullish'], result.sentiment)
  })
})