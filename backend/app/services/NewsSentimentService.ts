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
import { newsWindowScore, NewsEvent, NewsScoreResult } from './NewsScore.js'

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
   * Collapse analyses into distinct news events. Analyses of the same
   * story (same eventKey) merge into one event: timestamp = the earliest
   * article publish time, score = relevance×confidence-weighted mean of
   * the members, weight = 1 + 0.15·log2(n) (evidence bonus, capped 1.5).
   * Analyses without an eventKey (backfill / pre-migration) each form
   * their own event — same as before the dedup layer existed.
   */
  public analysesToEvents(analyses: any[]): NewsEvent[] {
    const clusters = new Map<string, { t: number; weighted: number; weightSum: number; members: number }>()

    for (const a of analyses) {
      const score = Number(a.sentimentScore)
      const relevance = Number(a.relevanceScore) || 0.1
      const confidence = Number(a.confidence) || 0.1
      if (!Number.isFinite(score)) continue

      const t = Date.parse(a.publishedAt || a.createdAt)
      if (!Number.isFinite(t) || t <= 0) continue

      const w = relevance * confidence
      const key = a.eventKey ? `ev:${a.eventKey}` : `an:${a.articleId}:${a.tickerId}`
      const cluster = clusters.get(key)
      if (cluster) {
        cluster.weighted += score * w
        cluster.weightSum += w
        cluster.members++
        if (t < cluster.t) cluster.t = t
      } else {
        clusters.set(key, { t, weighted: score * w, weightSum: w, members: 1 })
      }
    }

    return [...clusters.values()].map((c, i) => ({
      id: `${c.t}:${i}`,
      t: c.t,
      score: c.weightSum > 0 ? c.weighted / c.weightSum : 0,
      weight: Math.min(1 + 0.15 * Math.log2(Math.max(1, c.members)), 1.5),
    }))
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