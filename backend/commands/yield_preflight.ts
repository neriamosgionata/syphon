import { BaseCommand } from '@adonisjs/core/ace'
import { recordPreflightPass, runPreflight } from '#services/YieldPreflight'
import { tickerPrice } from '#services/KrakenYieldService'

// Preflight refuses live mode on any failure and records the result. A live
// yield tick requires a fresh passing row: run this immediately before the
// first mutating tick.

export default class YieldPreflightCommand extends BaseCommand {
  static commandName = 'yield:preflight'
  static description = 'Audit local, venue, and environment state before enabling YIELD_LIVE'
  static options = { startApp: true }

  static flags = [
    { flagName: 'json', name: 'json', type: 'boolean', description: 'Emit the checks as JSON' },
  ]

  async run() {
    let fastAlgoActive = false
    try {
      const { default: FastAlgoService } = await import('#services/FastAlgoService')
      fastAlgoActive = Boolean(FastAlgoService.status().active)
    } catch {
      fastAlgoActive = false
    }

    const result = await runPreflight({ fastAlgoSessionActive: fastAlgoActive, price: tickerPrice })

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

    await recordPreflightPass(result, Date.now())
    if (result.passed) {
      this.logger.info('Preflight PASSED — recorded; live mode may run within the freshness window')
      return
    }
    this.logger.error(`Preflight FAILED (${result.failed.join(', ')}) — live mode refused`)
    this.exitCode = 1
  }
}
