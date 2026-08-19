import { Job } from 'bullmq'
import logger from '@adonisjs/core/services/logger'
import MeilisearchService from '#services/MeilisearchService'
import TickerMatcherService from '#services/TickerMatcherService'
import QueueService, { QUEUE_NAMES } from './QueueService.js'

export async function processAnalyzeArticle(job: Job) {
  const { articleId } = job.data

  const article = await MeilisearchService.getArticle(articleId)
  if (!article) {
    logger.warn('[AnalyzeArticle] Article %d not found', articleId)
    return { skipped: true }
  }

  if (article.isAnalyzed) {
    logger.debug('[AnalyzeArticle] Article %d already analyzed', articleId)
    return { skipped: true }
  }

  await job.updateProgress({
    percent: 30,
    stage: 'Analyzing',
    detail: `Article #${articleId}: ${(article.title || '').slice(0, 50)}`,
  })

  const analyses = await TickerMatcherService.matchAndAnalyze(article)

  await job.updateProgress({
    percent: 100,
    stage: 'Complete',
    detail: `Matched ${analyses.length} tickers`,
  })

  logger.info(
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
