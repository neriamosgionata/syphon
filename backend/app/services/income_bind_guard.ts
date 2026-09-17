// ─── Income bind guard ─────────────────────────────────────────
//
// Fail-closed boot check (R15/U8): a mutating income line must not run on a
// non-loopback bind. The trend line is paper-only today (no order path), so
// only the yield line can trigger this; `trendLive` is the plug for the
// future live trend line and is never set true by the current wiring.

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost']

export interface IncomeLineState {
  yieldLive: boolean
  trendLive: boolean
}

export function assertIncomeBindSafe(host: string, lines: IncomeLineState): void {
  if (LOOPBACK_HOSTS.includes(host)) return

  const enabled: string[] = []
  if (lines.yieldLive) enabled.push('yield-live')
  if (lines.trendLive) enabled.push('trend-live')
  if (enabled.length === 0) return

  throw new Error(
    `refusing to start: ${enabled.join(', ')} requires a loopback HOST (got "${host || '(unset)'}")`
  )
}
