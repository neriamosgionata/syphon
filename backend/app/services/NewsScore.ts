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