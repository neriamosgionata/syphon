// Shared helpers for ace commands (backtest/kraken:*). Lives under app/
// because ace requires a default export from every file in commands/ and
// these are plain utilities. Not a service — no DI, no state.

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}