import { BaseCommand } from '@adonisjs/core/ace'
import { recordJevPreflightPass, runJevPreflight } from '#services/JevPreflight'

// Preflight refuses live enablement on any failure and records the result.
// A live (enforcing) Jev stage requires a fresh passing row: run this
// immediately before promoting past veto-only.

export default class JevPreflightCommand extends BaseCommand {
  static commandName = 'jev:preflight'
  static description = 'Audit credential, scorer, and alert state before enforcing the Jev overlay'
  static options = { startApp: true }

  static flags = [
    { flagName: 'json', name: 'json', type: 'boolean', description: 'Emit the checks as JSON' },
  ]

  async run() {
    const result = await runJevPreflight({})

    if (this.parsed.flags.json) {
      this.logger.info(JSON.stringify(result, null, 2))
      return
    }

    this.logger.info('')
    for (const layer of ['local', 'venue', 'environment'] as const) {
      this.logger.info(`── ${layer} ──`)
      for (const check of result.checks.filter((item) => item.layer === layer)) {
        this.logger.info(
          `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`
        )
      }
    }

    await recordJevPreflightPass(result, Date.now())
    if (result.passed) {
      this.logger.info('Preflight PASSED — recorded; live promotion may proceed within the freshness window')
      return
    }
    this.logger.error(`Preflight FAILED (${result.failed.join(', ')}) — live promotion refused`)
    this.exitCode = 1
  }
}
