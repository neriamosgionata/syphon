import { BaseCommand } from '@adonisjs/core/ace'
import TrendEvalService from '#services/TrendEvalService'

export default class TrendStatus extends BaseCommand {
  static commandName = 'trend:status'
  static description = 'Show the trend paper evaluation state, tripwire, and recent snapshots'
  static options = { startApp: true }

  static flags = [
    { flagName: 'json', name: 'json', type: 'boolean', description: 'Emit JSON' },
  ]

  async run() {
    const status = await TrendEvalService.status()

    if (this.parsed.flags.json) {
      this.logger.info(JSON.stringify(status, null, 2))
      return
    }

    this.logger.info('')
    this.logger.info(
      `Tripwire: ${status.trip.state}${status.trip.reasons.length ? ` — ${status.trip.reasons.join('; ')}` : ''}` +
        `${status.trip.since ? ` (since ${new Date(status.trip.since).toISOString()})` : ''}`
    )
    this.logger.info(
      `Last run: ${status.lastTick.at ? new Date(status.lastTick.at).toISOString() : 'never'}` +
        `${status.lastTick.stale ? '  [STALE]' : ''}`
    )

    this.logger.info('')
    this.logger.info('Recent evaluations:')
    if (status.evaluations.length === 0) this.logger.info('  (none)')
    for (const evaluation of status.evaluations) {
      this.logger.info(
        `  #${evaluation.id} ${evaluation.symbol} ${evaluation.state}${evaluation.provisional ? ' [provisional]' : ''} ` +
          `bars ${evaluation.bars}  net ${(evaluation.netReturnPct ?? 0).toFixed(2)}%  ` +
          `maxDD ${(evaluation.maxDrawdownPct ?? 0).toFixed(2)}%  green months ${evaluation.greenMonths ?? '—'}  ` +
          `trades ${evaluation.tradeCount ?? 0}`
      )
    }
  }
}
