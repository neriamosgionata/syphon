import { BaseCommand } from '@adonisjs/core/ace'
import TrendEvalService from '#services/TrendEvalService'

// Resuming a latched evaluation is an explicit operator action and requires
// a reason — the reason is recorded and alerted like every other transition.

export default class TrendResume extends BaseCommand {
  static commandName = 'trend:resume'
  static description = 'Resume a tripwire-halted trend evaluation (requires a reason)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'reason', name: 'reason', type: 'string', description: 'Why the evaluation is being resumed (required)' },
  ]

  async run() {
    const reason = this.parsed.flags.reason ? String(this.parsed.flags.reason) : ''
    if (!reason.trim()) {
      this.logger.error('--reason is required to resume a halted evaluation')
      this.exitCode = 1
      return
    }

    await TrendEvalService.resume(reason)
    this.logger.info(`Trend evaluation resumed — reason recorded: ${reason}`)
  }
}
