import { BaseCommand } from '@adonisjs/core/ace'
import { JevMonitor } from '#services/JevMonitor'

// Scheduled observability for the Jev overlay: calibration error,
// distribution drift, directional precision, and spend over recorded
// scores, with retention enforcement and the latching tripwire on breach.
// Run on a schedule (see docs/runbooks/jev-overlay.md) — the command is
// the scheduler; there is deliberately no in-process trigger.

export default class JevMonitorCommand extends BaseCommand {
  static commandName = 'jev:monitor'
  static description = 'Score Jev calibration, drift, precision, and spend; latch on breach; prune old scores'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbols', name: 'symbols', type: 'string', description: 'Comma-separated symbols (default BTC,ETH,SOL)' },
    { flagName: 'days', name: 'days', type: 'number', description: 'Trailing window in days (default 7)' },
    { flagName: 'horizon', name: 'horizon', type: 'number', description: 'Realized-direction horizon in minutes (default 5)' },
    { flagName: 'ece-breach', name: 'eceBreach', type: 'number', description: 'Latch when ECE exceeds this (default 0.35)' },
    { flagName: 'psi-breach', name: 'psiBreach', type: 'number', description: 'Latch when PSI exceeds this (default 0.5)' },
    { flagName: 'retention-days', name: 'retentionDays', type: 'number', description: 'Prune scores older than this (default 90)' },
    { flagName: 'json', name: 'json', type: 'boolean', description: 'Emit the report as JSON' },
  ]

  async run() {
    const symbols = String(this.parsed.flags.symbols || 'BTC,ETH,SOL')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0)
    const monitor = new JevMonitor()
    const report = await monitor.run({
      symbols,
      windowDays: Number(this.parsed.flags.days ?? 7),
      horizonMinutes: Number(this.parsed.flags.horizon ?? 5),
      eceBreach: Number(this.parsed.flags.eceBreach ?? 0.35),
      psiBreach: Number(this.parsed.flags.psiBreach ?? 0.5),
      retentionDays: Number(this.parsed.flags.retentionDays ?? 90),
    })

    if (this.parsed.flags.json) {
      this.logger.info(JSON.stringify(report, null, 2))
      return
    }

    this.logger.info('')
    this.logger.info(`Jev monitor (${symbols.join(',')}): ${report.scoredDecisions} scored, ${report.labeledDecisions} labeled`)
    this.logger.info(
      `ECE ${report.ece.toFixed(3)}   PSI ${report.psi.toFixed(3)}   precision ${
        report.precision === null ? 'n/a' : report.precision.toFixed(2)
      }   spend $${report.spend.spendUsd.toFixed(4)} (${report.spend.calls} calls)   pruned ${report.pruned}`
    )
    if (report.dataInsufficient) {
      this.logger.info('insufficient data — no verdict')
      return
    }
    if (report.breached) {
      this.logger.error('BREACH — overlay latched off, deterministic-only until resume')
      this.exitCode = 1
      return
    }
    this.logger.info('Within tolerance — no action taken')
  }
}
