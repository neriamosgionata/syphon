import Logger from '@ioc:Adonis/Core/Logger'
import Ticker from 'App/Models/Ticker'
import SentimentService from './SentimentService'
import MeilisearchService from './MeilisearchService'
import NotificationService from './NotificationService'

class TickerMatcherService {
  public async matchAndAnalyze(article: any): Promise<any[]> {
    const tickers = await Ticker.query().where('is_active', true)
    const results: any[] = []

    const textForRelevance = [article.title, article.summary, article.content]
      .filter(Boolean)
      .join(' ')

    for (const ticker of tickers) {
      const relevance = SentimentService.analyzeRelevance(
        textForRelevance,
        ticker.symbol,
        ticker.name
      )

      // Only analyze if relevance threshold is met
      if (relevance < 0.1) continue

      // Check for existing analysis
      const existing = await MeilisearchService.findAnalysis(article.id, ticker.id)
      if (existing) continue

      const sentiment = SentimentService.analyze(
        { title: article.title, summary: article.summary, content: article.content },
        ticker.symbol
      )

      const { id } = await MeilisearchService.saveAnalysis({
        articleId: article.id,
        tickerId: ticker.id,
        tickerSymbol: ticker.symbol,
        sentiment: sentiment.sentiment,
        sentimentScore: sentiment.sentimentScore,
        relevanceScore: relevance,
        confidence: sentiment.confidence,
        keywords: sentiment.keywords,
        reasoning: sentiment.reasoning,
        tickerPriceAtAnalysis: ticker.currentPrice,
      })

      results.push({
        id,
        articleId: article.id,
        tickerId: ticker.id,
        tickerSymbol: ticker.symbol,
        sentiment: sentiment.sentiment,
        sentimentScore: sentiment.sentimentScore,
        relevanceScore: relevance,
        confidence: sentiment.confidence,
        keywords: sentiment.keywords,
      })

      NotificationService.emit({
        type: 'ticker_match',
        articleId: article.id,
        articleTitle: article.title,
        articleUrl: article.url || null,
        sourceName: article.sourceName || null,
        ticker: {
          symbol: ticker.symbol,
          name: ticker.name,
          currentPrice: ticker.currentPrice,
        },
        sentiment: sentiment.sentiment,
        sentimentScore: sentiment.sentimentScore,
        relevanceScore: relevance,
        confidence: sentiment.confidence,
        keywords: sentiment.keywords,
        timestamp: new Date().toISOString(),
      })

      Logger.debug(
        'Analysis: %s -> %s | sentiment=%s score=%.3f relevance=%.3f',
        (article.title || '').slice(0, 50),
        ticker.symbol,
        sentiment.sentiment,
        sentiment.sentimentScore,
        relevance
      )
    }

    // Mark article as analyzed
    await MeilisearchService.updateArticle(article.id, {
      isAnalyzed: true,
      tickers: results.map((a) => a.tickerSymbol),
      sentiment: results.sort((a, b) => b.relevanceScore - a.relevanceScore)[0]?.sentiment || null,
      sentimentScore: results.sort((a, b) => b.relevanceScore - a.relevanceScore)[0]?.sentimentScore || null,
    })

    return results
  }
}

export default new TickerMatcherService()
