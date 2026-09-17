import { BaseCommand } from '@adonisjs/core/ace'
import { certifyTrend, loadResearchSamples, reportLines } from '#services/trend_config'
import { loadBacktestSamples } from '#services/backtest_data'

// Certification runs the frozen daily-trend config at its 5m cadence and
// records the evidence (config hash, snapshot, window, provenance,
// metrics). Sources: recorded Kraken bars (the gate), the Kraken OHLC
// cache, or the retired Binance 1m research cache (research-only).

export default class TrendCertify extends BaseCommand {
  static commandName = 'trend:certify'
  static description = 'Certify the frozen daily-trend config over recorded/window data'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Ticker symbol (default BTC)' },
    {
      flagName: 'source',
      name: 'source',
      type: 'string',
      description: 'bar_records|kraken|research (default bar_records)',
    },
    { flagName: 'hours', name: 'hours', type: 'number', description: 'Window in hours (defaults per source)' },
    { flagName: 'minBars', name: 'min-bars', type: 'number', description: 'Override the minimum bar count' },
  ]

  async run() {
    const symbol = String(this.parsed.flags.symbol || 'BTC').toUpperCase()
    const source = String(this.parsed.flags.source || 'bar_records')

    if (!['bar_records', 'kraken', 'research'].includes(source)) {
      this.logger.error(`Invalid --source=${source} — choose bar_records|kraken|research`)
      return
    }

    let samples
    let sourceLabel: string
    if (source === 'research') {
      const researchHours = Number(this.parsed.flags.hours ?? 0)
      samples = loadResearchSamples(symbol, undefined, researchHours)
      sourceLabel = `Binance 1m research cache resampled to 5m (research-only${researchHours > 0 ? `, last ${researchHours}h` : ''})`
    } else {
      const hours = Number(this.parsed.flags.hours ?? (source === 'bar_records' ? 24 * 400 : 24 * 3))
      const loaded = await loadBacktestSamples({
        symbol,
        intervalSeconds: 300,
        hours,
        source: source === 'bar_records' ? 'bar_records' : 'kraken',
        broker: 'kraken',
      })
      samples = loaded.samples
      sourceLabel = loaded.label
    }

    const minBars = this.parsed.flags.minBars ? Number(this.parsed.flags.minBars) : undefined
    const outcome = await certifyTrend({
      symbol,
      samples,
      provenance: source === 'research' ? 'research' : source === 'kraken' ? 'kraken' : 'bar_records',
      sourceLabel,
      minBars,
    })

    this.logger.info('')
    if (!outcome.certified) {
      this.logger.error(`Certification refused: ${outcome.reason}`)
      return
    }

    for (const line of reportLines([outcome.evaluation!])) {
      this.logger.info(line)
    }
  }
}
