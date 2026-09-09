// ─── Live news-sentiment service ───────────────────────────────
//
// Answers "what does the news say about symbol X right now?" for the fast
// algo gate. Reads analyses from Meilisearch, collapses them into distinct
// events via eventKey (title-similarity clusters stamped at ingest), and
// runs the shared pure aggregation (NewsScore.newsWindowScore) with the
// SAME window/half-life semantics the backtester uses.
//
// Source articles are deduped at ingest; analyses carrying the same
// eventKey get a small evidence bonus (more sources agreeing on a story =
// more confidence in its direction) but never count as separate votes.
//
// Fail-open: any error returns null — the news gate must never block
// trading on an infrastructure failure (price signals still run).

import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import MeilisearchService from './MeilisearchService.js'
import { newsWindowScore, analysesToNewsEvents, NewsScoreResult } from './NewsScore.js'

const SENTIMENT_CACHE_MS = 60_000

interface SentimentCacheEntry {
  at: number
  result: NewsScoreResult
}

export class NewsSentimentService {
  private cache = new Map<string, SentimentCacheEntry>()

  constructor(
    private meili: typeof MeilisearchService = MeilisearchService,
    private redisClient: any = redis
  ) {}

  /**
   * Collapse analyses into distinct news events — shared pure logic in
   * NewsScore.analysesToNewsEvents (also used by the quant engine).
   */
  public analysesToEvents(analyses: any[]) {
    return analysesToNewsEvents(analyses)
  }

  /**
   * Recency-weighted news sentiment for a ticker over the last
   * `windowHours`. Null when there are no analyses in the window (the
   * gate treats null as "no news — don't block"). Cached 60s.
   */
  public async getSymbolSentiment(
    tickerId: number,
    windowHours: number = 24
  ): Promise<NewsScoreResult | null> {
    if (!windowHours || windowHours <= 0) windowHours = 24
    const cacheKey = `${tickerId}:${windowHours}`
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.at < SENTIMENT_CACHE_MS) {
      return cached.result
    }

    try {
      const since = new Date(Date.now() - windowHours * 3600_000).toISOString()
      const analyses = await this.meili.getAnalysesForTicker(tickerId, since)
      const events = this.analysesToEvents(analyses)
      const result = newsWindowScore(events, Date.now(), windowHours * 3600)
      this.cache.set(cacheKey, { at: Date.now(), result })
      return result
    } catch (err) {
      logger.error('[NewsSentiment] Failed to score %d: %s', tickerId, (err as Error).message)
      return null
    }
  }
}

export default new NewsSentimentService()