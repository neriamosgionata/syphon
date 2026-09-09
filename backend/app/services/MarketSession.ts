// ─── Market session gate (pure) ────────────────────────────────
//
// Crypto trades 24/7; listed instruments only during their exchange
// session. The strategy's UTC-hour gate cannot express equity sessions
// (ET timezone, weekends, holidays), so the venue layer answers "is this
// symbol tradable right now?" and the algo loop skips entries when not.
//
// Fallback model (no IBKR tradingHours yet): US-equity session
// Mon-Fri 09:30-16:00 America/New_York minus market holidays. The holiday
// list is year-scoped — extend when the calendar flips. Unknown exchange /
// instrument → open (fail-open: never block on missing session data).

const HALF_DAY_CLOSE_ET = 13 * 60

export const US_EQUITY_HOLIDAYS_2026: Array<{ month: number; day: number }> = [
  { month: 1, day: 1 },   // New Year's Day
  { month: 1, day: 19 },  // Martin Luther King Jr. Day
  { month: 2, day: 16 },  // Presidents' Day
  { month: 4, day: 3 },   // Good Friday
  { month: 5, day: 25 },  // Memorial Day
  { month: 6, day: 19 },  // Juneteenth
  { month: 7, day: 3 },   // Independence Day (observed)
  { month: 9, day: 7 },   // Labor Day
  { month: 11, day: 26 }, // Thanksgiving
  { month: 12, day: 25 }, // Christmas
]

export interface SessionStatus {
  open: boolean
  reason: 'open' | 'closed' | 'weekend' | 'holiday' | 'outside_hours' | 'unknown'
}

function etParts(now: number): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(now)

  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value || 0)
  const dow = parts.find((p) => p.type === 'weekday')?.value || ''
  const dowMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  const hour = get('hour') === 24 ? 0 : get('hour')
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), dow: dowMap[dow] ?? 0 }
}

function isHoliday(year: number, month: number, day: number): boolean {
  const list = year === 2026 ? US_EQUITY_HOLIDAYS_2026 : []
  return list.some((h) => h.month === month && h.day === day)
}

/** US-equity session check. `halfDay` (13:00 close) respected. */
export function isEquitySessionOpen(now: number, opts: { halfDay?: boolean } = {}): SessionStatus {
  const p = etParts(now)
  if (p.dow === 6 || p.dow === 7) return { open: false, reason: 'weekend' }
  if (isHoliday(p.year, p.month, p.day)) return { open: false, reason: 'holiday' }

  const minutes = p.hour * 60 + p.minute
  const closeMin = opts.halfDay ? HALF_DAY_CLOSE_ET : 16 * 60
  if (minutes < 9 * 60 + 30) return { open: false, reason: 'outside_hours' }
  if (minutes >= closeMin) return { open: false, reason: 'outside_hours' }
  return { open: true, reason: 'open' }
}

/** Venue-agnostic: crypto always open; listed instruments use the session. */
export function isSessionOpen(now: number, secType: string | null | undefined): SessionStatus {
  if (!secType || secType === 'crypto') return { open: true, reason: 'open' }
  return isEquitySessionOpen(now)
}