// ─── Pure news-window scoring ──────────────────────────────────
//
// Turns a stream of dated sentiment events into ONE recency-weighted
// sentiment score for a symbol over a window. This is the shared math
// behind the live loop (NewsSentimentService) and the backtester
// (BacktestEngine replays historical GDELT tone through it) — live and
// backtest must agree on the aggregation or the news gate is untestable.
//
// Model:
// - events: one per distinct news event (event clusters collapse to one)
// - score: relevance×confidence-weighted mean of the member analyses
// - decay: exponential, half-life = windowSeconds / 4 — an event 6h old
//   still counts ~25% inside a 24h window
// - magnitude: Σ decayed weights — news VOLUME proxy (how much signal
//   actually exists, not just its direction)

export interface NewsEvent {
  /** Event cluster id — events with the same id are counted once. */
  id?: string
  /** Epoch ms the event became known. */
  t: number
  /** Sentiment in [-1, 1]. */
  score: number
  /** Evidence weight (e.g. how many sources carried the story). */
  weight?: number
}

export interface NewsScoreResult {
  /** Recency-weighted sentiment, null when no events in the window. */
  score: number | null
  /** Distinct events inside the window. */
  events: number
  /** Σ decayed weights — news-volume proxy. */
  magnitude: number
  /** Simple (unweighted) mean over the window — for diagnostics. */
  meanScore: number
}

export function newsWindowScore(
  events: NewsEvent[],
  now: number,
  windowSeconds: number,
  halfLifeSeconds?: number
): NewsScoreResult {
  if (!windowSeconds || windowSeconds <= 0) {
    return { score: null, events: 0, magnitude: 0, meanScore: 0 }
  }
  const halfLife = halfLifeSeconds && halfLifeSeconds > 0 ? halfLifeSeconds : windowSeconds / 4
  const decay = (ageMs: number): number => Math.exp((-ageMs * Math.LN2) / (halfLife * 1000))

  let weighted = 0
  let weightSum = 0
  let magnitude = 0
  let plainSum = 0
  let eventsInWindow = 0
  const seen = new Set<string>()

  for (const ev of events) {
    if (ev.t <= 0 || !Number.isFinite(ev.score)) continue
    const ageMs = now - ev.t
    if (ageMs < 0 || ageMs >= windowSeconds * 1000) continue
    // Dedup by event id (cluster key) — duplicates must never double-count.
    const id = ev.id ?? ev.t
    if (seen.has(id)) continue
    seen.add(id)

    const w = decay(ageMs) * (ev.weight && ev.weight > 0 ? ev.weight : 1)
    weighted += ev.score * w
    weightSum += w
    magnitude += w
    plainSum += ev.score
    eventsInWindow++
  }

  if (eventsInWindow === 0 || weightSum <= 0) {
    return { score: null, events: 0, magnitude: 0, meanScore: 0 }
  }

  return {
    score: Number((weighted / weightSum).toFixed(4)),
    events: eventsInWindow,
    magnitude: Number(magnitude.toFixed(4)),
    meanScore: Number((plainSum / eventsInWindow).toFixed(4)),
  }
}
/**
 * Collapse Meilisearch analyses into distinct news events — the shared
 * live/quantscore path. Analyses of the same story (same eventKey) merge
 * into one event: timestamp = earliest publish, score = relevance×confidence
 * weighted mean, weight = evidence bonus 1 + 0.15·log2(n) capped 1.5.
 * Analyses without an eventKey (backfill / pre-migration) each form their
 * own event.
 */
export function analysesToNewsEvents(analyses: any[]): NewsEvent[] {
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
