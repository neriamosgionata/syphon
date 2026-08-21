import { BaseCommand, flags } from '@adonisjs/core/ace'
import fs from 'node:fs'
import path from 'node:path'
import { fetchBinanceKlines1s } from '#services/BinanceKlineService'
import type { BacktestSample } from '#services/BacktestEngine'

const CACHE_DIR = path.join(process.cwd(), 'backtests', 'cache')

// Accumulate 1s kline cache daily: Binance's 1s history is short, and the
// walk-forward calibration needs months of data before any ML work makes
// sense. Merges fresh samples into the existing cache file for each symbol,
// reusing the exact cache filename format the other backtest commands read.
// Intended as a cron job (e.g. `bun ace backtest:update-cache` nightly).

export default class BacktestUpdateCache extends BaseCommand {
  static commandName = 'backtest:update-cache'
  static description = 'Fetch the latest 1s klines and merge them into the backtest cache'
  static options = { startApp: true }

  @flags.string({ description: 'Comma-separated symbols (default BTC,ETH,SOL)' })
  declare symbols: string

  @flags.number({ description: 'Hours to fetch per run (default 24, max 72)' })
  declare hours: number

  @flags.string({ description: 'Cache hours tag — must match the backtest window you calibrate with (default 72)' })
  declare cacheHours: number

  async run() {
    const symbols = (this.symbols || 'BTC,ETH,SOL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const hours = Math.min(Math.max(this.hours || 24, 1), 72)
    const cacheHours = this.cacheHours || 72

    for (const symbol of symbols) {
      const cacheFile = path.join(CACHE_DIR, `${symbol}_1s_${cacheHours}h_v2.json`)
      let pre: BacktestSample[] = []
      try {
        if (fs.existsSync(cacheFile)) {
          pre = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BacktestSample[]
        }
      } catch {
        this.logger.warn(`Cache unreadable for ${symbol}, starting fresh`)
      }

      const endTime = Date.now()
      const startTime = endTime - hours * 3600_000
      const cursorStart = pre.length > 0 ? pre[pre.length - 1].t + 1 : startTime
      if (cursorStart > endTime) {
        this.logger.info(`${symbol}: cache already current (${pre.length} samples)`)
        continue
      }

      this.logger.info(`${symbol}: fetching ${hours}h of 1s klines from ${new Date(cursorStart).toISOString()} …`)
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      const samples = await fetchBinanceKlines1s(symbol, cursorStart, endTime, {
        onProgress: (partial) => {
          try {
            const merged = [...pre, ...partial]
              .sort((a, b) => a.t - b.t)
              .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
            fs.writeFileSync(cacheFile, JSON.stringify(merged))
          } catch { /* checkpoint write is best-effort */ }
        },
      })

      const merged = [...pre, ...samples]
        .sort((a, b) => a.t - b.t)
        .filter((s, i, arr) => i === 0 || arr[i - 1].t !== s.t)
      // Trim to the cache window: older samples would silently grow the file
      // forever and change the backtest window every run.
      const cutoff = endTime - cacheHours * 3600_000
      const trimmed = merged.filter((s) => s.t >= cutoff)
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(trimmed))
        this.logger.info(`${symbol}: cached ${trimmed.length} samples (${((trimmed[trimmed.length - 1].t - trimmed[0].t) / 3600_000).toFixed(1)}h window)`)
      } catch (err) {
        this.logger.warn(`Failed to cache ${symbol}: ${(err as Error).message}`)
      }
    }
  }
}
