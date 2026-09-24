// ─── Bar resampling (pure) ─────────────────────────────────────
//
// Aggregate a finer sample series into coarser bars: first sample's close
// becomes the bar's close-anchor (no true open exists in BacktestSample),
// last close becomes the bar close, high/low are max/min, volume sums.
// Fully missing buckets produce no bar — gaps are preserved, never
// smoothed. Partial buckets are emitted with the samples they have.

import type { BacktestSample } from '#services/BacktestEngine'

export function resampleSamples(
  samples: BacktestSample[],
  sourceSeconds: number,
  targetSeconds: number
): BacktestSample[] {
  if (targetSeconds <= sourceSeconds) {
    throw new Error(`resample requires target > source (${targetSeconds} <= ${sourceSeconds})`)
  }
  if (targetSeconds % sourceSeconds !== 0) {
    throw new Error(`resample target must be a multiple of source (${targetSeconds} % ${sourceSeconds})`)
  }

  const targetMs = targetSeconds * 1000
  const buckets = new Map<number, BacktestSample>()

  for (const sample of samples) {
    const bucket = Math.floor(sample.t / targetMs) * targetMs
    const existing = buckets.get(bucket)
    if (!existing) {
      buckets.set(bucket, {
        t: bucket,
        p: sample.p,
        h: sample.h ?? sample.p,
        l: sample.l ?? sample.p,
        v: sample.v ?? 0,
      })
      continue
    }
    existing.h = Math.max(existing.h ?? sample.p, sample.h ?? sample.p)
    existing.l = Math.min(existing.l ?? sample.p, sample.l ?? sample.p)
    existing.p = sample.p
    existing.v = (existing.v ?? 0) + (sample.v ?? 0)
  }

  return [...buckets.values()].sort((a, b) => a.t - b.t)
}

/** Keep only samples inside the trailing `hours` window (hours <= 0 = all). */
export function filterRecentSamples(
  samples: BacktestSample[],
  hours: number,
  now: number = Date.now()
): BacktestSample[] {
  if (!hours || hours <= 0) return samples
  const start = now - hours * 3600_000
  return samples.filter((sample) => sample.t >= start)
}
