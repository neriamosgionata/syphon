import { BaseCommand } from '@adonisjs/core/ace'
import FundingCarryService from '#services/FundingCarryService'

export default class CarryTick extends BaseCommand {
  static commandName = 'carry:tick'
  static description = 'Run one funding-carry evaluation pass (paper)'
  static options = { startApp: true }

  async run() {
    await FundingCarryService.tick()
    const s = await FundingCarryService.summary()
    this.logger.info('')
    this.logger.info(`Carry summary: ${s.open} open / ${s.halted} halted of ${s.assets} assets — ` +
      `funding $${s.fundingUsd.toFixed(2)}, total P&L $${s.totalPnlUsd.toFixed(2)} (${s.paper ? 'paper' : 'live'})`)
  }
}