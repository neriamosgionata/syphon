import { BaseCommand } from '@adonisjs/core/ace'
import CarryPosition from '#models/CarryPosition'

export default class CarryStatus extends BaseCommand {
  static commandName = 'carry:status'
  static description = 'Show funding-carry paper position state'
  static options = { startApp: true }

  async run() {
    const rows = await CarryPosition.all()
    if (rows.length === 0) {
      this.logger.info('No carry positions yet — run `bun ace carry:tick` to open the paper basket.')
      return
    }
    this.logger.info('')
    this.logger.info('=== Funding-carry positions ===')
    for (const r of rows) {
      const opened = r.openedAt ? r.openedAt.toISO() : '-'
      const total = r.fundingReceivedUsd + r.basisUsd + r.spotPnlUsd + r.perpPnlUsd
      this.logger.info(
        `${r.symbol.padEnd(6)} ${r.status.padEnd(10)} notional $${(r.spotNotional ?? 0).toFixed(0)}  ` +
        `funding $${r.fundingReceivedUsd.toFixed(2)}  basis $${r.basisUsd.toFixed(2)}  ` +
        `spotPnL $${r.spotPnlUsd.toFixed(2)}  perpPnL $${r.perpPnlUsd.toFixed(2)}  total $${total.toFixed(2)}  ` +
        `opened ${opened}` +
        (r.haltReason ? `  HALT: ${r.haltReason}` : '')
      )
    }
    const open = rows.filter((r) => r.status === 'open' || r.status === 'monitoring')
    const funding = open.reduce((s, r) => s + r.fundingReceivedUsd, 0)
    this.logger.info('')
    this.logger.info(`Basket: ${open.length} open, funding received $${funding.toFixed(2)} (paper)`)
  }
}