// ─── Trend evaluation slices (pure) ────────────────────────────
//
// Monthly/quarterly return slices and month-streak helpers computed from
// an equity curve. Shared by certification (U7) and the paper evaluator
// (U6) so both derive the same statistics from the same curve.

export interface EquityPoint {
  t: number
  value: number
}

export interface PeriodSlice {
  period: string
  start: number
  end: number
  startEquity: number
  endEquity: number
  returnPct: number
}

function periodKey(t: number, period: 'month' | 'quarter'): string {
  const date = new Date(t)
  const year = date.getUTCFullYear()
  if (period === 'month') {
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    return `${year}-${month}`
  }
  return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`
}

export function sliceEquityCurve(curve: EquityPoint[], period: 'month' | 'quarter'): PeriodSlice[] {
  const slices: PeriodSlice[] = []
  let current: PeriodSlice | null = null
  let previousClose: number | null = null

  for (const point of curve) {
    const key = periodKey(point.t, period)
    if (!current || current.period !== key) {
      if (current) slices.push(current)
      current = {
        period: key,
        start: point.t,
        end: point.t,
        // Month-end-to-month-end: a period starts where the previous one closed.
        startEquity: previousClose === null ? point.value : previousClose,
        endEquity: point.value,
        returnPct: 0,
      }
    } else {
      current.end = point.t
      current.endEquity = point.value
    }
    previousClose = point.value
  }
  if (current) slices.push(current)

  for (const slice of slices) {
    slice.returnPct = slice.startEquity > 0 ? ((slice.endEquity / slice.startEquity) - 1) * 100 : 0
  }
  return slices
}

export function greenMonthCount(slices: PeriodSlice[]): number {
  return slices.filter((slice) => slice.returnPct > 0).length
}

/** Trailing streak of consecutive negative-return months at the end of the series. */
export function trailingNegativeMonthStreak(slices: PeriodSlice[]): number {
  let streak = 0
  for (let i = slices.length - 1; i >= 0; i--) {
    if (slices[i].returnPct < 0) streak++
    else break
  }
  return streak
}
