// ─── News event dedup / clustering ──────────────────────────────
//
// The same story travels through many channels (CoinDesk, CoinTelegraph,
// The Block, Google News aggregations, ...) with different URLs, so
// externalId/url dedup misses it entirely. Without event clustering every
// duplicate adds a full vote to the news sentiment score — 5 copies of one
// headline read as 5x the signal.
//
// Approach: bag-of-words title fingerprint. A pure probe (sorted unique
// tokens, first 3 as bucket key) is checked against a Redis-stored cluster;
// a Jaccard overlap >= 0.6 on the full token sets joins the cluster. The
// cluster's canonical id is the FIRST article's id, so downstream scoring
// can group analyses by eventKey with no extra bookkeeping.
//
// Fail-open: any Redis error returns null (article saves unclustered) —
// ingestion must never be blocked by the dedup layer.

import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'

const EVENT_TTL_SECONDS = 72 * 3600
const MIN_TOKENS = 5
const JACCARD_MIN = 0.6
const PROBE_TOKENS = 3

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'from', 'that',
  'this', 'these', 'those', 'its', 'has', 'have', 'been', 'will', 'would',
  'was', 'were', 'are', 'is', 'of', 'to', 'in', 'on', 'at', 'by', 'as',
  'after', 'before', 'over', 'under', 'into', 'onto', 'up', 'down', 'out',
  'off', 'now', 'not', 'no', 'more', 'most', 'than', 'then', 'they', 'their',
  'who', 'what', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'may',
  'can', 'could', 'should', 'about', 'into', 'against', 'between', 'during',
])

export interface EventProbe {
  probe: string
  tokens: string[]
}

/**
 * Pure title fingerprint. Returns null for titles too generic to cluster
 * (fewer than MIN_TOKENS significant tokens). `probe` = the first
 * PROBE_TOKENS of the sorted unique token set (cheap Redis key);
 * `tokens` = the full sorted unique set (for the Jaccard check).
 */
export function eventProbe(title: string): EventProbe | null {
  const raw = (title || '').toLowerCase().match(/[a-z0-9]+/g) || []
  const significant = raw.filter(
    (t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t)
  )
  if (significant.length < MIN_TOKENS) return null

  const tokens = [...new Set(significant)].sort()
  return { probe: tokens.slice(0, PROBE_TOKENS).join(':'), tokens }
}

export function tokensJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let intersection = 0
  for (const t of a) if (setB.has(t)) intersection++
  const union = new Set([...a, ...b]).size
  return union > 0 ? intersection / union : 0
}

interface StoredCluster {
  eventKey: string
  tokens: string[]
  ts: number
}

export class EventDedupService {
  constructor(private redisClient: any = redis) {}

  /**
   * Resolve the event cluster for a title, using `articleId` as the
   * canonical cluster key when the title opens a new cluster. Returns null
   * when the title is too generic to cluster or Redis is unavailable.
   */
  public async getOrCreateEvent(title: string, articleId: number): Promise<string | null> {
    const probe = eventProbe(title)
    if (!probe) return null

    const key = `news:event:${probe}`
    try {
      const raw = await this.redisClient.get(key)
      if (raw) {
        let cluster: StoredCluster
        try {
          cluster = JSON.parse(raw)
        } catch {
          cluster = null as any
        }
        if (cluster && typeof cluster.eventKey === 'string') {
          if (tokensJaccard(probe.tokens, cluster.tokens || []) >= JACCARD_MIN) {
            await this.redisClient.expire(key, EVENT_TTL_SECONDS)
            return cluster.eventKey
          }
        }
      }

      const fresh: StoredCluster = { eventKey: String(articleId), tokens: probe.tokens, ts: Date.now() }
      await this.redisClient.set(key, JSON.stringify(fresh), 'EX', EVENT_TTL_SECONDS)
      return fresh.eventKey
    } catch (err) {
      logger.warn('[EventDedup] Redis unavailable, saving unclustered: %s', (err as Error).message)
      return null
    }
  }
}

export default new EventDedupService()