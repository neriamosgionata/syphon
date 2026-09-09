// ─── IBKR real-time price feed ─────────────────────────────────
//
// PriceFeed implementation over IBKR reqMktData — the stock/ETF side of
// the fast algo. Contracts are resolved from the Ticker model
// (sec_type/exchange/currency, migration 23), so any listed instrument
// works: STK/ETF → SMART, crypto → CRYPTO, index → IND.
//
// The feed is a thin delegation layer: IBKRService owns the connection
// and the tickPrice cache (same stale-10s semantics as KrakenWS), this
// class maps app symbols → IBKR contracts and tracks subscriptions.

import logger from '@adonisjs/core/services/logger'
import Ticker from '#models/Ticker'
import IBKRService from './IBKRService.js'
import type { PriceFeed } from './market_types.js'

const IBKR_SEC_TYPE: Record<string, string> = {
  crypto: 'CRYPTO',
  stock: 'STK',
  etf: 'STK',
  index: 'IND',
  fund: 'FUND',
  future: 'FUT',
}

export class IBKRPriceFeed implements PriceFeed {
  private subscribed = new Set<string>()
  private contractCache = new Map<string, any>()
  private tickerModel: typeof Ticker
  private ibkr: any

  constructor(deps: { tickerModel?: typeof Ticker; ibkr?: any } = {}) {
    this.tickerModel = deps.tickerModel ?? Ticker
    this.ibkr = deps.ibkr ?? IBKRService
  }

  public async connect(symbols: string[]): Promise<void> {
    for (const s of symbols) this.addSymbol(s)
  }

  public disconnect(): void {
    this.subscribed.clear()
  }

  public addSymbol(symbol: string): void {
    const s = symbol.toUpperCase()
    if (this.subscribed.has(s)) return
    this.subscribed.add(s)
    void this.ensureContract(s)
  }

  public removeSymbol(symbol: string): void {
    this.subscribed.delete(symbol.toUpperCase())
  }

  public getPrice(symbol: string): number | null {
    return this.ibkr.getMarketPrice(symbol.toUpperCase())
  }

  public getConnectedSymbols(): string[] {
    return [...this.subscribed]
  }

  /**
   * Resolve the IBKR contract for a symbol (cached), then subscribe if the
   * symbol is still tracked. Missing ticker rows log once and skip — IBKR
   * cannot trade instruments without contract metadata.
   */
  private async ensureContract(symbol: string): Promise<void> {
    let contract = this.contractCache.get(symbol)
    if (contract === undefined) {
      try {
        const ticker = await this.tickerModel.findBy('symbol', symbol)
        if (!ticker) {
          logger.warn('[IBKRFeed] No ticker row for %s — cannot build a contract', symbol)
          this.contractCache.set(symbol, null)
          return
        }
        const secType = IBKR_SEC_TYPE[ticker.secType] || 'STK'
        contract = {
          symbol,
          secType,
          exchange: ticker.exchange || (secType === 'CRYPTO' ? 'PAXOS' : 'SMART'),
          currency: ticker.currency || 'USD',
        }
        this.contractCache.set(symbol, contract)
      } catch (err) {
        logger.error('[IBKRFeed] Contract resolution failed for %s: %s', symbol, (err as Error).message)
        return
      }
    }
    if (contract && this.subscribed.has(symbol)) {
      this.ibkr.reqMktData(symbol, contract)
    }
  }
}

export default new IBKRPriceFeed()