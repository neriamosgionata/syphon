import { BaseCommand } from '@adonisjs/core/ace'
import JevRollout, { type JevStage } from '#services/JevRollout'

// Operator stage control for the Jev overlay. Promotion is one step at a
// time with a clear alert board; standing down and latching off are always
// allowed; resume re-enters shadow (alerts stay for `alerts:ack`).

export default class JevStageCommand extends BaseCommand {
  static commandName = 'jev:stage'
  static description = 'Show or move the Jev overlay stage (shadow|veto_only|live), resume, or latch off'
  static options = { startApp: true }

  static flags = [
    { flagName: 'set', name: 'set', type: 'string', description: 'Move to stage: shadow|veto_only|live' },
    { flagName: 'reason', name: 'reason', type: 'string', description: 'Reason recorded with the move' },
    { flagName: 'resume', name: 'resume', type: 'boolean', description: 'Clear the latch and re-enter shadow' },
    { flagName: 'latch-off', name: 'latchOff', type: 'boolean', description: 'Latch the overlay off immediately' },
  ]

  async run() {
    const set = this.parsed.flags.set as string | undefined
    const reason = (this.parsed.flags.reason as string | undefined) ?? 'operator command'
    const resume = Boolean(this.parsed.flags.resume)
    const latchOff = Boolean(this.parsed.flags.latchOff)

    if (latchOff) {
      await JevRollout.latchOff(reason)
      this.logger.info('Jev overlay latched off — deterministic-only until resume')
      return
    }
    if (resume) {
      await JevRollout.resume(reason)
      this.logger.info('Jev latch cleared — re-entered shadow')
      return
    }
    if (set) {
      if (set !== 'shadow' && set !== 'veto_only' && set !== 'live') {
        this.logger.error(`Invalid --set=${set} — choose shadow|veto_only|live`)
        this.exitCode = 1
        return
      }
      const result = await JevRollout.setStage(set as JevStage, reason)
      if (!result.ok) {
        this.logger.error(`Stage move refused: ${result.error}`)
        this.exitCode = 1
        return
      }
      this.logger.info(`Jev stage → ${set}`)
      return
    }

    const [stage, latched, enforcing] = await Promise.all([
      JevRollout.getStage(),
      JevRollout.isLatched(),
      JevRollout.isEnforcing(),
    ])
    this.logger.info(`Jev stage: ${stage} (latched: ${latched ? 'yes' : 'no'}, enforcing: ${enforcing ? 'yes' : 'no'})`)
  }
}
