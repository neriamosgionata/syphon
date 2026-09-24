import { BaseCommand } from '@adonisjs/core/ace'
import TrendEvaluation from '#models/TrendEvaluation'
import { reportLines } from '#services/trend_config'

// Renders stored evaluation snapshots — never the live config row, so a
// later config edit cannot rewrite what a certification reported.

export default class TrendReport extends BaseCommand {
  static commandName = 'trend:report'
  static description = 'Show stored trend evaluations and certifications (from their snapshots)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbol', name: 'symbol', type: 'string', description: 'Filter by ticker symbol' },
    { flagName: 'limit', name: 'limit', type: 'number', description: 'Max rows (default 10)' },
    { flagName: 'json', name: 'json', type: 'boolean', description: 'Emit raw JSON' },
  ]

  async run() {
    const query = TrendEvaluation.query().orderBy('window_end', 'desc').limit(Number(this.parsed.flags.limit ?? 10))
    if (this.parsed.flags.symbol) query.where('symbol', String(this.parsed.flags.symbol).toUpperCase())
    const rows = await query

    if (rows.length === 0) {
      this.logger.info('No trend evaluations yet — run `bun ace trend:certify --symbol=BTC --source=research`.')
      return
    }

    if (this.parsed.flags.json) {
      this.logger.info(JSON.stringify(rows.map((row) => row.toJSON()), null, 2))
      return
    }

    this.logger.info('')
    for (const line of reportLines(rows)) this.logger.info(line)
  }
}
