import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import { BacktestEngine, BacktestConfig, BacktestResult, BacktestSample } from '#services/BacktestEngine'
import { fetchBinanceKlines } from '#services/BinanceKlineService'
import {
  DAILY_TREND_PRODUCT,
  DAILY_TREND_PRODUCT_ASSETS,
  DAILY_TREND_PRODUCT_ENGINE,
  dailyTrendStrategy,
} from '#services/DailyTrendProduct'

// Repeatable certification runner for the frozen daily-trend product
// (ALGO_PRODUCT.md). Re-runs the exact freeze numbers on the cached 1m
// multi-year data and checks the risk-contract tripwires:
//   - every calendar year net-positive
//   - no two consecutive negative months
//   - max drawdown bound (soft)
// Config lives in app/services/DailyTrendProduct.ts — edit there, not here.

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

export default class BacktestProduct extends BaseCommand {
  static commandName = 'backtest:product'
  static description = 'Certify the frozen daily-trend product against its risk contract'
  static options = { startApp: true }

  @flags.string({ description: 'Comma-separated symbols (default BTC,ETH,SOL)' })
  declare symbols: string

  @flags.number({ description: 'Days of history (default 1095)' })
  declare days: number

  @flags.number({ description: 'Bar interval seconds: 60 (1m, default) or 300 (5m, decimates cache)' })
  declare intervalSeconds: number

  @flags.boolean({ description: 'Skip the cache and refetch from Binance' })
  declare fresh: boolean

  async run() {
    const days = Math.min(Math.max(this.days || 1095, 30), 3650)
    const intervalSeconds = this.intervalSeconds === 300 ? 300 : 60
    const symbols = (this.symbols || DAILY_TREND_PRODUCT_ASSETS.join(','))
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)

    const endTime = Date.now()
    const startTime = endTime - days * 24 * 3600_000
    const engine = new BacktestEngine()

    interface AssetResult { symbol: string; result: BacktestResult; monthly: Map<string, number> }
    const assets: AssetResult[] = []
    for (const symbol of symbols) {
      let samples = await this.loadSamples(symbol, startTime, endTime, days)
      if (intervalSeconds === 300) samples = this.toBars(samples, 300)
      if (samples.length < 2) {
        this.logger.error(`No data for ${symbol} — skipping`)
        continue
      }
      const cfg: BacktestConfig = {
        symbol,
        strategy: dailyTrendStrategy(intervalSeconds),
        loopIntervalSeconds: intervalSeconds,
        portfolioUsd: DAILY_TREND_PRODUCT_ENGINE.portfolioUsdPerAsset,
        feePct: DAILY_TREND_PRODUCT_ENGINE.feePct,
        maxPositions: 1,
        maxExposurePct: 0.9,
        maxSinglePositionPct: 0.9,
        cooldownSeconds: DAILY_TREND_PRODUCT_ENGINE.cooldownSeconds,
        slippageBps: DAILY_TREND_PRODUCT_ENGINE.slippageBps,
      }
      const result = engine.run(samples, cfg)
      assets.push({ symbol, result, monthly: this.monthlyReturns(result) })
    }
    if (assets.length === 0) return

    // Composite monthly series = equal-weight mean across assets.
    const months = new Set<string>()
    for (const a of assets) for (const m of a.monthly.keys()) months.add(m)
    const composite: Array<{ m: string; ret: number }> = []
    for (const m of [...months].sort()) {
      const vals = assets.map((a) => a.monthly.get(m)).filter((v): v is number => v !== undefined)
      if (vals.length === assets.length) composite.push({ m, ret: vals.reduce((x, y) => x + y, 0) / vals.length })
    }

    this.logger.info('')
    this.logger.info(`=== Product certification: daily-trend ER14d/40 (frozen 2026-09-07) ===`)
    this.logger.info(`Config: EMA-1d trend (slope>=1.5%/3d) + regime 4d>=1.5%/7d + ER14d>=40 | SL 5% trail 12/6 | fee ${DAILY_TREND_PRODUCT_ENGINE.feePct * 100}% + ${DAILY_TREND_PRODUCT_ENGINE.slippageBps}bps | ${intervalSeconds}s bars | ${days}d`)
    this.logger.info('')

    const fmt = (v: number) => (v === Infinity ? 'inf' : v.toFixed(2))
    const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

    for (const a of assets) {
      const m = a.result.metrics
      this.logger.info(`${a.symbol}: net ${pct(a.result.strategyReturnPct)}  ${m.totalTrades}t  WR ${(m.winRate * 100).toFixed(0)}%  PF ${fmt(m.profitFactor)}  maxDD ${m.maxDrawdownPct.toFixed(1)}%  buy&hold ${pct(a.result.buyHoldReturnPct)}`)
    }

    this.logger.info('')
    this.logger.info('Composite calendar years:')
    const byYear = new Map<string, number[]>()
    for (const c of composite) {
      const y = c.m.slice(0, 4)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y)!.push(c.ret)
    }
    for (const [y, rets] of [...byYear.entries()].sort()) {
      const net = rets.reduce((s, r) => s + r, 0)
      const up = rets.filter((r) => r > 0).length
      this.logger.info(`  ${y}: ${pct(net)}  green ${up}/${rets.length}`)
    }

    const netTotal = composite.reduce((s, c) => s + c.ret, 0)
    const avgMonth = netTotal / composite.length
    const upMonths = composite.filter((c) => c.ret > 0).length
    const worst = Math.min(...composite.map((c) => c.ret))
    let streak = 0
    let maxStreak = 0
    for (const c of composite) {
      if (c.ret < 0) { streak++; maxStreak = Math.max(maxStreak, streak) }
      else streak = 0
    }
    const maxDDAll = Math.max(...assets.map((a) => a.result.metrics.maxDrawdownPct))
    const yearsAll = [...byYear.keys()].filter((y) => y !== '2023')
    const allYearsPositive = yearsAll.every((y) => (byYear.get(y) || []).reduce((s, r) => s + r, 0) > 0)

    this.logger.info('')
    this.logger.info('Risk contract check:')
    this.logger.info(`  months ${composite.length} | avg ${pct(avgMonth)}/mo | green ${upMonths}/${composite.length} | worst ${pct(worst)} | longest losing streak ${maxStreak}`)
    this.logger.info(`  years net-positive (${yearsAll.join('/')}): ${allYearsPositive ? 'PASS' : 'FAIL'}`)
    this.logger.info(`  no 2+ consecutive negative months: ${maxStreak <= 1 ? 'PASS' : `FAIL (streak ${maxStreak})`}`)
    this.logger.info(`  maxDD across assets: ${maxDDAll.toFixed(1)}%  ${maxDDAll < 40 ? '(within expectation ~10-35%)' : '(above expectation — investigate)'}`)
    this.logger.info(`  tripwire: two consecutive negative months or >15% DD applies to PAPER TRADING, not backtest.`)
    this.logger.info('')
    this.logger.info(`Frozen row: ${JSON.stringify(DAILY_TREND_PRODUCT).slice(0, 120)}… (full: app/services/DailyTrendProduct.ts)`)
  }

  /** Aggregate raw bars into coarser bars, preserving intrabar h/l. */
  private toBars(raw: BacktestSample[], intervalSeconds: number): BacktestSample[] {
    const out: BacktestSample[] = []
    let cur: BacktestSample | null = null
    for (const s of raw) {
      if (!cur || s.t - cur.t >= intervalSeconds * 1000) {
        cur = { t: s.t, p: s.p, h: s.h, l: s.l }
        out.push(cur)
      } else {
        cur.p = s.p
        if (s.h !== undefined && (cur.h === undefined || s.h > cur.h)) cur.h = s.h
        if (s.l !== undefined && (cur.l === undefined || s.l < cur.l)) cur.l = s.l
      }
    }
    return out
  }

  private monthlyReturns(result: BacktestResult): Map<string, number> {
    const byMonth = new Map<string, [number, number]>()
    for (let i = 1; i < result.equityCurve.length; i++) {
      const key = new Date(result.equityCurve[i].t).toISOString().slice(0, 7)
      const prev = byMonth.get(key)
      if (!prev) byMonth.set(key, [result.equityCurve[i - 1].value, result.equityCurve[i].value])
      else prev[1] = result.equityCurve[i].value
    }
    const out = new Map<string, number>()
    for (const [k, [a, b]] of byMonth) if (a > 0 && b >= 0) out.set(k, ((b - a) / a) * 100)
    return out
  }

  private async loadSamples(symbol: string, startTime: number, endTime: number, days: number): Promise<BacktestSample[]> {
    const cacheFile = path.join(CACHE_DIR, `${symbol}_1m_${days}d.json`)
    let pre: BacktestSample[] = []
    if (!this.fresh && fs.existsSync(cacheFile)) {
      try {
        pre = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
      } catch { /* refetch */ }
    }
    const first = pre[0]?.t
    const last = pre[pre.length - 1]?.t
    if (pre.length >= 2 && first !== undefined && last !== undefined &&
        first <= startTime + 60_000) {
      if (last >= endTime - 120_000) {
        this.logger.info(`Loaded ${pre.length} cached 1m samples for ${symbol}`)
        return pre
      }
      // Cache starts at the right place but is stale by (endTime - last):
      // top up ONLY the missing tail instead of refetching the whole span.
      this.logger.info(`Cache for ${symbol} stale by ${((endTime - last) / 3600_000).toFixed(1)}h — fetching tail…`)
      const tail = await fetchBinanceKlines(symbol, last + 1, endTime, { intervalSeconds: 60 })
      const merged = [...pre, ...tail]
        .sort((a, b) => a.t - b.t)
        .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
      fs.writeFileSync(cacheFile, JSON.stringify(merged))
      this.logger.info(`Cache ${symbol} topped up to ${merged.length} samples`)
      return merged
    }
    this.logger.info(`Fetching ${days}d of 1m klines for ${symbol}…`)
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const samples = await fetchBinanceKlines(symbol, startTime, endTime, { intervalSeconds: 60 })
    fs.writeFileSync(cacheFile, JSON.stringify(samples))
    return samples
  }
}
