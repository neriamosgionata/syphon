// ─── IBKR contract helpers (shared by price feed + fast engine) ──

export const IBKR_SEC_TYPE: Record<string, string> = {
  crypto: 'CRYPTO',
  stock: 'STK',
  etf: 'STK',
  index: 'IND',
  fund: 'FUND',
  future: 'FUT',
}

/** Ticker row → IBKR contract. Exchange defaults: SMART, CRYPTO→PAXOS. */
export function contractForTicker(ticker: {
  symbol: string
  secType: string
  exchange: string | null
  currency: string | null
}): any {
  const secType = IBKR_SEC_TYPE[ticker.secType] || 'STK'
  return {
    symbol: ticker.symbol,
    secType,
    exchange: ticker.exchange || (secType === 'CRYPTO' ? 'PAXOS' : 'SMART'),
    currency: ticker.currency || 'USD',
  }
}