import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import Article from 'App/Models/Article'
import TickerMatcherService from 'App/Services/TickerMatcherService'
import QueueService, { QUEUE_NAMES } from './QueueService'

export async function processAnalyzeArticle(job: Job) {
  const { articleId } = job.data

  const article = await Article.find(articleId)
  if (!article) {
    Logger.warn('[AnalyzeArticle] Article %d not found', articleId)
    return { skipped: true }
  }

  if (article.isAnalyzed) {
    Logger.debug('[AnalyzeArticle] Article %d already analyzed', articleId)
    return { skipped: true }
  }

  const analyses = await TickerMatcherService.matchAndAnalyze(article)

  Logger.info(
    '[AnalyzeArticle] Article %d: matched %d tickers',
    articleId,
    analyses.length
  )

  return {
    articleId,
    analysesCreated: analyses.length,
    matches: analyses.map((a) => ({
      tickerId: a.tickerId,
      sentiment: a.sentiment,
      score: a.sentimentScore,
    })),
  }
}

export function registerAnalyzeArticleWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.ANALYZE_ARTICLE, processAnalyzeArticle, 5)
}
