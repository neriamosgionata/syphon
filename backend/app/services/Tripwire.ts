// ─── Trend tripwires (pure) ────────────────────────────────────
//
// Latching halt conditions from the frozen product's own risk contract:
// two consecutive negative months, or a drawdown greater than 15% from
// peak equity. Only decision-grade evaluations feed this — provisional
// (warm-up or gapped) runs cannot trip a tripwire.

import { trailingNegativeMonthStreak, type PeriodSlice } from '#services/trend_metrics'

export const TREND_TRIPWIRES = {
  maxDrawdownPct: 15,
  maxConsecutiveNegativeMonths: 2,
} as const

export interface TripwireInput {
  maxDrawdownPct: number
  monthly: PeriodSlice[] | null
}

export interface TripwireVerdict {
  tripped: boolean
  reasons: string[]
}

export function evaluateTripwires(input: TripwireInput): TripwireVerdict {
  const reasons: string[] = []

  if (input.maxDrawdownPct > TREND_TRIPWIRES.maxDrawdownPct) {
    reasons.push(`drawdown ${input.maxDrawdownPct.toFixed(2)}% > ${TREND_TRIPWIRES.maxDrawdownPct}%`)
  }

  if (input.monthly && input.monthly.length > 0) {
    const streak = trailingNegativeMonthStreak(input.monthly)
    if (streak >= TREND_TRIPWIRES.maxConsecutiveNegativeMonths) {
      reasons.push(`${streak} consecutive negative months`)
    }
  }

  return { tripped: reasons.length > 0, reasons }
}
