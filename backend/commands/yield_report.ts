import fs from 'node:fs'
import { BaseCommand } from '@adonisjs/core/ace'
import YieldReward from '#models/YieldReward'
import { buildYieldReportCsv } from '#services/YieldReport'

// Reward export for tax/accounting. Native units with the venue refid; EUR
// fair-value valuation and tax treatment are explicitly not applied.

function parseInstant(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const text = String(value)
  if (/^\d+$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

export default class YieldReport extends BaseCommand {
  static commandName = 'yield:report'
  static description = 'Export persisted Kraken Earn rewards as CSV (native units)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'from', name: 'from', type: 'string', description: 'Start (ISO date or epoch ms; default 30d ago)' },
    { flagName: 'to', name: 'to', type: 'string', description: 'End (ISO date or epoch ms; default now)' },
    { flagName: 'out', name: 'out', type: 'string', description: 'Write CSV to this file instead of stdout' },
  ]

  async run() {
    const now = Date.now()
    const fromMs = parseInstant(this.parsed.flags.from) ?? now - 30 * 86_400_000
    const toMs = parseInstant(this.parsed.flags.to) ?? now

    const rows = await YieldReward.query()
      .where('time', '>=', fromMs)
      .where('time', '<=', toMs)
      .orderBy('time', 'asc')

    const csv = buildYieldReportCsv(rows)
    const out = this.parsed.flags.out ? String(this.parsed.flags.out) : null
    if (out) {
      fs.writeFileSync(out, csv)
      this.logger.info(`Wrote ${rows.length} reward row(s) to ${out}`)
      return
    }
    this.logger.info(csv)
  }
}
