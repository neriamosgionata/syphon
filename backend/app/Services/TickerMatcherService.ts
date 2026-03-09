import Logger from '@ioc:Adonis/Core/Logger'
import Ticker from 'App/Models/Ticker'
import Article from 'App/Models/Article'
import Analysis from 'App/Models/Analysis'
import SentimentService from './SentimentService'
import OpenSearchService from './OpenSearchService'

class TickerMatcherService {
  public async matchAndAnalyze(article: Article): Promise<Analysis[]> {
    const tickers = await Ticker.query().where('is_active', true)
    const results: Analysis[] = []

    const textToAnalyze = [article.title, article.summary, article.content]
      .filter(Boolean)
      .join(' ')

    for (const ticker of tickers) {
      const relevance = SentimentService.analyzeRelevance(
        textToAnalyze,
        ticker.symbol,
        ticker.name
      )

      // Only analyze if relevance threshold is met
      if (relevance < 0.1) continue

      // Check for existing analysis
      const existing = await Analysis.query()
        .where('article_id', article.id)
        .where('ticker_id', ticker.id)
        .first()

      if (existing) continue

      const sentiment = SentimentService.analyze(textToAnalyze, ticker.symbol)

      const analysis = await Analysis.create({
        articleId: article.id,
        tickerId: ticker.id,
        sentiment: sentiment.sentiment,
        sentimentScore: sentiment.sentimentScore,
        relevanceScore: relevance,
        confidence: sentiment.confidence,
        keywords: sentiment.keywords,
        reasoning: sentiment.reasoning,
        tickerPriceAtAnalysis: ticker.currentPrice,
      })

      results.push(analysis)

      Logger.debug(
        'Analysis: %s -> %s | sentiment=%s score=%.3f relevance=%.3f',
        article.title.slice(0, 50),
        ticker.symbol,
        sentiment.sentiment,
        sentiment.sentimentScore,
        relevance
      )
    }

    // Mark article as analyzed
    article.isAnalyzed = true
    await article.save()

    // Update OpenSearch with analysis data
    const bestAnalysis = results.sort((a, b) => b.relevanceScore - a.relevanceScore)[0]
    await OpenSearchService.indexArticle({
      id: article.id,
      title: article.title,
      summary: article.summary,
      content: article.content,
      url: article.url,
      source_name: article.sourceName,
      author: article.author,
      published_at: article.publishedAt?.toISO() || null,
      tickers: results.map((a) => tickers.find((t) => t.id === a.tickerId)!.symbol),
      sentiment: bestAnalysis?.sentiment || null,
      sentiment_score: bestAnalysis?.sentimentScore || null,
    })

    return results
  }
}

export default new TickerMatcherService()
