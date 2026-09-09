// ─── Venue/instrument-agnostic market interfaces ───────────────
//
// The app trades whatever instrument a broker offers (Kraken crypto,
// IBKR stocks/ETFs, later funds/indexes). Every venue-specific piece
// implements these contracts; FastAlgoService, the recorders and the
// backtest data path consume ONLY the interfaces, so adding a venue is
// one new implementation, never a change to the algo core.
//
// Implementations today:
//   PriceFeed             KrakenWebSocketService | IBKRPriceFeed
//   FastExecutionEngine   KrakenFastEngine        | (IBKRFastEngine — P2)
//   EquityProvider        KrakenService           | IBKRService
//   MarketDataProvider    KrakenDataService       | (IBKRDataService — P3)

export interface FastOrderRequest {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  orderType?: 'MARKET' | 'LIMIT'
  price?: number
  timeInForce?: string
}

export interface FastOrderState {
  clientOrderId: string
  externalOrderId: string | null
  tradeId: number | null
  tickerId: number | null
  symbol: string
  side: 'BUY' | 'SELL'
  orderType: string
  quantity: number
  limitPrice: number | null
  stopPrice: number | null
  status: string
  filledQuantity: number
  fillPrice: number | null
  commission: number | null
  commissionAsset: string | null
  submittedAt: number
  filledAt: number | null
  cancelledAt: number | null
  errorMessage: string | null
  dirty: boolean
}

/**
 * Real-time price source feeding the 1s MomentumFeed. KrakenWS (public
 * ticker) and IBKRPriceFeed (reqMktData tickPrice) both implement it.
 */
export interface PriceFeed {
  connect(symbols: string[]): Promise<void> | void
  disconnect(): void
  addSymbol(symbol: string): void
  removeSymbol(symbol: string): void
  /** Last price, null when stale (>10s) or unknown. */
  getPrice(symbol: string): number | null
  getConnectedSymbols(): string[]
  /** Symbol-scoped trade events (KrakenWS trade channel; IBKR later). */
  onTrade?(symbol: string, cb: (trade: any) => void): () => void
}

/**
 * Fast-path execution: place/cancel orders, track fills, link to trade
 * rows. KrakenFastEngine today; IBKRFastEngine (P2) mirrors it.
 */
export interface FastExecutionEngine {
  running: boolean
  start(symbols: string[]): Promise<void>
  placeOrder(opts: FastOrderRequest): Promise<FastOrderState>
  cancelOrder(clientOrderId: string): Promise<any>
  getOrdersBySymbol(symbol: string): FastOrderState[]
  getPrice?(symbol: string): number | null
  pruneCompletedOrders?(): void
}

/**
 * Account equity in the portfolio currency — drives position sizing and
 * the daily-loss circuit breaker.
 */
export interface EquityProvider {
  isConnected: boolean
  connect?(): Promise<boolean>
  getEquity(): Promise<number>
}

/**
 * Historical market data for backtests + caches. KrakenDataService today;
 * IBKRDataService (P3) serves stock bars from reqHistoricalData.
 */
export interface MarketDataProvider {
  getOHLC(symbol: string, intervalMinutes: number, since?: number): Promise<{
    candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>
    lastTime: number | null
  }>
  getTrades?(symbol: string, sinceTradeId?: string): Promise<{
    trades: Array<{ price: number; volume: number; time: number; side: string; ordertype: string }>
    lastTradeId: string | null
  }>
  walkOHLC(symbol: string, intervalMinutes: number, targetStartMs: number, maxPages?: number): Promise<any[]>
}