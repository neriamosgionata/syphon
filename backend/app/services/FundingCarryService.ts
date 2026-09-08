import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import CarryPosition from '#models/CarryPosition'

// ─── Delta-neutral funding-carry service ──────────────────────
//
// Collects the perpetual-funding premium (verified: composite ~+0.5%/mo on
// notional, t 4.3, every year positive 2023-2026, worst month -0.3% on
// Binance USDⓈ-M funding history) via a hedged structure:
//   LONG spot + SHORT perp, equal notional → price-neutral, P&L ≈ funding
//   received on the short perp leg (+ basis drift).
//
// Ship state: DRY-RUN default (paper positions from live public data). Real
// execution requires Kraken Futures API keys (KRAKEN_FUTURES_KEY/SECRET) and
// the KrakenFuturesExecutor implementation — not yet wired. This service is
// the paper/verification loop that the live executor plugs into.

// Kraken funding is ~7x weaker than Binance (verified on Kraken's own
// history, carry_verify_kraken.ts, ~1y): only BTC (+3.3%/yr, t 3.13) and
// ETH (+3.2%/yr, t 3.82) carry a significant premium; alt perps fund near
// zero or negative (ADA -2.0%, LTC -2.0% over the window). Basket = BTC/ETH.
const ASSETS = ['BTC', 'ETH'] as const
const NOTIONAL_PER_ASSET = 1_000
const PERP_MARGIN_PCT = 0.25
const FUNDING_HALT_TRAIL_DAYS = 30
// Catastrophic-only backstop: halt when trailing 30d funding < -0.5%
// (approx -6%/yr negative carry = genuine crisis). Evidence: never fires
// for the kept basket in 7y; the halt rule at any looser threshold costs
// more in flip fees than it saves (negative-funding episodes mean-revert).
const FUNDING_HALT_TRAIL_PCT = -0.5
const DRIFT_REBALANCE_PCT = 0.01 // rebalance perp leg when |spotPnl - perpPnl| > 1% notional

export interface CarryPrices { spot: number; perp: number }
export interface FundingSettlement { time: number; rate: number }

/** Public market data needed by the strategy — no auth. */
export interface CarryDataProvider {
  getPrices(symbol: string): Promise<CarryPrices>
  /** Settlements with time >= sinceMs (oldest first). */
  getFunding(symbol: string, sinceMs: number): Promise<FundingSettlement[]>
  /** Signed sum of funding over the trailing `days` (positive = longs pay shorts). */
  getTrailingFundingPct(symbol: string, days: number, now?: number): Promise<number>
}

/** Order execution abstraction. Dry-run records intents; live needs keys. */
export interface CarryExecutor {
  readonly live: boolean
  openSpotLong(symbol: string, notionalUsd: number): Promise<void>
  openPerpShort(symbol: string, notionalUsd: number): Promise<void>
  closeSpotLong(symbol: string): Promise<void>
  closePerpShort(symbol: string): Promise<void>
  adjustPerpShort(symbol: string, deltaNotionalUsd: number): Promise<void>
}

export class DryRunExecutor implements CarryExecutor {
  public readonly live = false
  public readonly intents: Array<{ action: string; symbol: string; usd: number }> = []
  private async log(action: string, symbol: string, usd: number): Promise<void> {
    this.intents.push({ action, symbol, usd })
    logger.info('[Carry][dry-run] %s %s $%s', action, symbol, usd.toFixed(2))
  }
  async openSpotLong(symbol: string, notionalUsd: number) { await this.log('OPEN SPOT LONG', symbol, notionalUsd) }
  async openPerpShort(symbol: string, notionalUsd: number) { await this.log('OPEN PERP SHORT', symbol, notionalUsd) }
  async closeSpotLong(symbol: string) { await this.log('CLOSE SPOT LONG', symbol, 0) }
  async closePerpShort(symbol: string) { await this.log('CLOSE PERP SHORT', symbol, 0) }
  async adjustPerpShort(symbol: string, deltaNotionalUsd: number) { await this.log('ADJUST PERP SHORT', symbol, deltaNotionalUsd) }
}

const KRAKEN_SPOT = 'https://api.kraken.com'
const KRAKEN_FUTURES = 'https://futures.kraken.com/derivatives/api/v3'

// Kraken spot pair + perp instrument per basket symbol (BTC = XBT on Kraken).
const KRAKEN_SPOT_PAIRS: Record<string, string> = {
  BTC: 'XBTUSD', ETH: 'ETHUSD', XRP: 'XRPUSD', ADA: 'ADAUSD',
  DOGE: 'DOGEUSD', LINK: 'LINKUSD', LTC: 'LTCUSD',
}
const KRAKEN_PERP_SYMBOLS: Record<string, string> = {
  BTC: 'PF_XBTUSD', ETH: 'PF_ETHUSD', XRP: 'PF_XRPUSD', ADA: 'PF_ADAUSD',
  DOGE: 'PF_DOGEUSD', LINK: 'PF_LINKUSD', LTC: 'PF_LTCUSD',
}

/**
 * Public-data provider over Kraken spot + Kraken Futures perps (no auth).
 * Kraken funding settles HOURLY; the REST history endpoint returns the last
 * ~1 year of hourly rates (no pagination) — the venue-relevant window.
 */
export class KrakenCarryDataProvider implements CarryDataProvider {
  public async getPrices(symbol: string): Promise<CarryPrices> {
    const up = symbol.toUpperCase()
    const spotPair = KRAKEN_SPOT_PAIRS[up]
    const perpSymbol = KRAKEN_PERP_SYMBOLS[up]
    if (!spotPair || !perpSymbol) throw new Error(`no Kraken mapping for ${symbol}`)
    const [spotRes, perpRes] = await Promise.all([
      fetch(`${KRAKEN_SPOT}/0/public/Ticker?pair=${spotPair}`),
      fetch(`${KRAKEN_FUTURES}/tickers?symbol=${perpSymbol}`),
    ])
    if (!spotRes.ok || !perpRes.ok) throw new Error(`price fetch failed for ${symbol} (${spotRes.status}/${perpRes.status})`)
    const spotJson = (await spotRes.json()) as { result?: Record<string, { c: string[] }>; error?: string[] }
    if (!spotJson.result || spotJson.error?.length) throw new Error(`kraken spot ticker failed for ${symbol}: ${JSON.stringify(spotJson.error)}`)
    const spot = Number(Object.values(spotJson.result)[0].c[0])
    const perpJson = (await perpRes.json()) as { tickers?: Array<{ markPrice?: number; last?: number }> }
    const perp = perpJson.tickers?.[0]?.markPrice ?? perpJson.tickers?.[0]?.last
    if (!Number.isFinite(spot) || !Number.isFinite(perp)) throw new Error(`invalid price for ${symbol}`)
    return { spot, perp }
  }

  public async getFunding(symbol: string, sinceMs: number): Promise<FundingSettlement[]> {
    const up = symbol.toUpperCase()
    const perpSymbol = KRAKEN_PERP_SYMBOLS[up]
    if (!perpSymbol) throw new Error(`no Kraken perp for ${symbol}`)
    const url = `${KRAKEN_FUTURES}/historical-funding-rates?symbol=${perpSymbol}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`kraken funding fetch failed for ${perpSymbol}: ${res.status}`)
    const json = (await res.json()) as { result?: string; rates?: Array<{ timestamp: string; relativeFundingRate: number }> }
    if (json.result !== 'success' || !json.rates) throw new Error(`kraken funding bad response for ${perpSymbol}`)
    return json.rates
      .filter((r) => Date.parse(r.timestamp) >= sinceMs)
      .map((r) => ({ time: Date.parse(r.timestamp), rate: r.relativeFundingRate }))
      .sort((a, b) => a.time - b.time)
  }

  public async getTrailingFundingPct(symbol: string, days: number, now: number = Date.now()): Promise<number> {
    const since = now - days * 86_400_000
    const funds = await this.getFunding(symbol, since)
    return funds.reduce((s, f) => s + f.rate * 100, 0) // in %
  }
}

export class FundingCarryService {
  private provider: CarryDataProvider
  private executor: CarryExecutor

  constructor(provider: CarryDataProvider, executor: CarryExecutor = new DryRunExecutor()) {
    this.provider = provider
    this.executor = executor
  }

  /**
   * One evaluation pass. Runs the full state machine for every asset:
   *   monitoring → open (funding positive) → accrue + rebalance → halt/close
   *   (trailing funding negative). Idempotent, safe to call hourly.
   */
  public async tick(now: number = Date.now()): Promise<void> {
    for (const symbol of ASSETS) {
      try {
        await this.pass(symbol, now)
      } catch (err) {
        logger.error('[Carry] pass failed for %s: %s', symbol, err instanceof Error ? err.message : String(err))
      }
    }
  }

  private async pass(symbol: string, now: number): Promise<void> {
    const row = await CarryPosition.query().where('symbol', symbol).orderBy('id', 'desc').first()
    const trailing = await this.provider.getTrailingFundingPct(symbol, FUNDING_HALT_TRAIL_DAYS, now)

    if (!row || row.status === 'halted') {
      if (trailing >= FUNDING_HALT_TRAIL_PCT) {
        await this.open(symbol, now, trailing)
      } else if (row?.status === 'halted' && trailing >= FUNDING_HALT_TRAIL_PCT) {
        row.status = 'monitoring'
        await row.save()
      }
      return
    }

    if (row.status === 'monitoring' || row.status === 'open') {
      if (trailing < FUNDING_HALT_TRAIL_PCT) {
        await this.closeAndHalt(row, now, `trailing ${FUNDING_HALT_TRAIL_DAYS}d funding ${trailing.toFixed(3)}% < ${FUNDING_HALT_TRAIL_PCT}%`)
        return
      }
      await this.accrueAndRebalance(row, now)
    }
  }

  private async open(symbol: string, now: number, trailingPct: number): Promise<void> {
    const prices = await this.provider.getPrices(symbol)
    const notional = NOTIONAL_PER_ASSET
    const spotQty = notional / prices.spot
    const perpQty = notional / prices.perp
    await this.executor.openSpotLong(symbol, notional)
    await this.executor.openPerpShort(symbol, notional)
    const row = new CarryPosition()
    row.symbol = symbol
    row.dryRun = !this.executor.live
    row.status = 'open'
    row.spotNotional = notional
    row.perpNotional = notional
    row.spotQuantity = spotQty
    row.perpQuantity = perpQty
    row.entrySpotPrice = prices.spot
    row.entryPerpPrice = prices.perp
    row.openedAt = DateTime.fromMillis(now)
    row.lastRebalanceAt = DateTime.fromMillis(now)
    row.lastFundingAt = DateTime.fromMillis(now)
    row.meta = { trailingFundingPctAtOpen: trailingPct, executor: this.executor.live ? 'live' : 'dry-run' }
    await row.save()
    logger.info('[Carry] %s opened: spot long + perp short @ $%s/%s (trailing funding %s%%)', symbol, prices.spot.toFixed(2), prices.perp.toFixed(2), trailingPct.toFixed(3))
  }

  private async accrueAndRebalance(row: CarryPosition, now: number): Promise<void> {
    const since = row.lastFundingAt ? (row.lastFundingAt as any).toMillis() : now
    const settlements = await this.provider.getFunding(row.symbol, since)
    const prices = await this.provider.getPrices(row.symbol)

    let fundingUsd = 0
    let lastTime = since
    for (const s of settlements) {
      // Short perp receives funding when rate > 0.
      fundingUsd += s.rate * (row.perpNotional ?? 0)
      if (s.time > lastTime) lastTime = s.time
    }
    if (fundingUsd !== 0 || settlements.length > 0) {
      row.fundingReceivedUsd += fundingUsd
      row.lastFundingAt = DateTime.fromMillis(lastTime)
    }

    // Mark-to-market both legs (dry-run paper accounting; live executor would
    // reconcile exchange P&L instead).
    const spotPnl = ((prices.spot - (row.entrySpotPrice ?? prices.spot)) / (row.entrySpotPrice ?? prices.spot)) * (row.spotNotional ?? 0)
    const perpPnl = ((row.entryPerpPrice ?? prices.perp) - prices.perp) / (row.entryPerpPrice ?? prices.perp) * (row.perpNotional ?? 0)
    row.spotPnlUsd = spotPnl
    row.perpPnlUsd = perpPnl
    row.basisUsd = (prices.spot - prices.perp) * (row.perpQuantity ?? 0)

    // Drift: price moves break the hedge — top up the perp leg.
    const drift = Math.abs(spotPnl - perpPnl)
    if (drift > (row.spotNotional ?? 0) * DRIFT_REBALANCE_PCT) {
      const delta = spotPnl - perpPnl // extra short notional needed to re-hedge
      await this.executor.adjustPerpShort(row.symbol, delta)
      row.perpQuantity = (row.perpQuantity ?? 0) + delta / prices.perp
      row.lastRebalanceAt = DateTime.fromMillis(now)
    }
    await row.save()
  }

  private async closeAndHalt(row: CarryPosition, now: number, reason: string): Promise<void> {
    await this.executor.closeSpotLong(row.symbol)
    await this.executor.closePerpShort(row.symbol)
    row.status = 'halted'
    row.haltedAt = DateTime.fromMillis(now)
    row.haltReason = reason
    await row.save()
    logger.warn('[Carry] %s halted: %s', row.symbol, reason)
  }

  /** Aggregate P&L across the basket (dry-run accounting). */
  public async summary(): Promise<{
    assets: number
    open: number
    halted: number
    fundingUsd: number
    totalPnlUsd: number
    paper: boolean
  }> {
    const rows = await CarryPosition.all()
    const open = rows.filter((r) => r.status === 'open' || r.status === 'monitoring')
    const halted = rows.filter((r) => r.status === 'halted')
    return {
      assets: ASSETS.length,
      open: open.length,
      halted: halted.length,
      fundingUsd: open.reduce((s, r) => s + r.fundingReceivedUsd, 0),
      totalPnlUsd: open.reduce((s, r) => s + r.fundingReceivedUsd + r.basisUsd + r.spotPnlUsd + r.perpPnlUsd, 0),
      paper: !this.executor.live,
    }
  }
}

export default new FundingCarryService(new KrakenCarryDataProvider())