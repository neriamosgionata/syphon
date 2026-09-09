import { BaseCommand } from '@adonisjs/core/ace'
import Ticker from '#models/Ticker'
import MeilisearchService from '#services/MeilisearchService'
import { validateTicker, summarizeValidation } from '#services/QuantValidator'

// Point-in-time validation of the quant composite score. Answers: does a
// high score predict forward returns? Replays each ticker's history at a
// coarse cadence (every N bars) through the production snapshot path and
// measures Spearman ICs (time-series + cross-sectional) and quintile
// forward returns. ICs near zero = the screener ranks on noise.

export default class QuantValidate extends BaseCommand {
  static commandName = 'quant:validate'
  static description = 'Validate the quant composite score against forward returns (point-in-time)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbols', name: 'symbols', type: 'string', description: 'Comma-separated symbols (default: all active tickers)' },
    { flagName: 'step', name: 'step', type: 'number', description: 'Validation cadence in bars (default 5)' },
    { flagName: 'forward', name: 'forward', type: 'number', description: 'Forward return horizon in bars (default 20)' },
    { flagName: 'warmup', name: 'warmup', type: 'number', description: 'Minimum bars before scoring starts (default 60)' },
    { flagName: 'maxTickers', name: 'maxTickers', type: 'number', description: 'Cap on tickers validated (default 0 = all)' },
  ]

  async run() {
    const symbolsRaw = String(this.parsed.flags.symbols || '').toUpperCase()
    const step = Number(this.parsed.flags.step ?? 5)
    const forward = Number(this.parsed.flags.forward ?? 20)
    const warmup = Number(this.parsed.flags.warmup ?? 60)
    const maxTickers = Number(this.parsed.flags.maxTickers ?? 0)

    const tickers = symbolsRaw
      ? await Ticker.query().whereIn('symbol', symbolsRaw.split(',').map((s) => s.trim())).where('is_active', true)
      : await Ticker.query().where('is_active', true).orderBy('symbol')
    const wanted = maxTickers > 0 ? tickers.slice(0, maxTickers) : tickers
    if (wanted.length === 0) {
      this.logger.error('No active tickers found')
      return
    }

    const spy = await Ticker.findBy('symbol', 'SPY')
    const spySnapshots = spy ? await MeilisearchService.getSnapshotsForTicker(spy.id) : []
    const spyReturns = spySnapshots.map((s: any) => Number(s.close)).filter(Boolean)
      .map((c: number, i: number, arr: number[]) => (i === 0 ? 0 : c / arr[i - 1] - 1))

    this.logger.info(`═══ Quant validation: ${wanted.length} tickers, step ${step}d, forward ${forward}d ═══`)
    this.logger.info('Loading snapshots + analyses…')

    const rowsByTicker = new Map<string, any[]>()
    const results: any[] = []
    let scored = 0
    let skipped = 0

    for (const ticker of wanted) {
      const snapshots = await MeilisearchService.getSnapshotsForTicker(ticker.id)
      if (snapshots.length < warmup + forward + 1) {
        skipped++
        continue
      }
      const analyses = await MeilisearchService.getAnalysesForTicker(
        ticker.id,
        new Date(Date.now() - 400 * 86400000).toISOString()
      )
      const bars = snapshots.map((s: any) => ({
        date: s.date,
        open: Number(s.open || s.close) || 0,
        high: Number(s.high || s.close) || 0,
        low: Number(s.low || s.close) || 0,
        close: Number(s.close) || 0,
        volume: Number(s.volume) || 0,
      }))

      const result = validateTicker({
        symbol: ticker.symbol,
        bars,
        analyses,
        spyReturns,
        meta: ticker.metadata,
        secType: ticker.secType,
        step,
        forward,
        warmup,
      })
      rowsByTicker.set(ticker.symbol, result.rows)
      results.push(result)
      scored++
      if (scored % 25 === 0) this.logger.info('  …%d/%d scored', scored, wanted.length)
    }

    const summary = summarizeValidation(results, rowsByTicker as any)

    this.logger.info('')
    this.logger.info(`═══ Summary: ${summary.tickers} tickers, ${summary.rows} point-in-time rows ═══`)
    this.logger.info(`Composite IC (time-series):     ${summary.compositeIcTimeSeries?.toFixed(3) ?? 'n/a'}`)
    this.logger.info(`Composite IC (cross-sectional): ${summary.compositeIcCrossSectional?.toFixed(3) ?? 'n/a'}   (95% null band ±${summary.nullBand95?.toFixed(3) ?? 'n/a'})`)
    this.logger.info('')
    this.logger.info('Component IC (time-series, higher = more predictive):')
    const comps = Object.entries(summary.componentIc).sort((a, b) => b[1] - a[1])
    for (const [name, ic] of comps) {
      this.logger.info(`  ${name.padEnd(18)} ${ic >= 0 ? '+' : ''}${ic.toFixed(3)}`)
    }
    this.logger.info('')
    this.logger.info('Quintile forward returns (pooled):')
    for (const q of summary.quintileForward) {
      this.logger.info(`  ${q.label.padEnd(8)} ${(q.meanForward * 100).toFixed(2)}%  (n=${q.n})`)
    }
    this.logger.info('')
    this.logger.info(`Skipped (insufficient bars): ${skipped}`)
  }
}