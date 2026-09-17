import { BaseCommand } from '@adonisjs/core/ace'
import KrakenYieldService from '#services/KrakenYieldService'

export default class YieldTick extends BaseCommand {
  static commandName = 'yield:tick'
  static description = 'Run one Kraken Earn allocation tick (observe unless YIELD_LIVE)'
  static options = { startApp: true }

  async run() {
    const result = await KrakenYieldService.tick()
    this.logger.info('')
    this.logger.info(
      `Yield tick: ${result.status} (${result.live ? 'live' : 'observe'})` +
        (result.reason ? ` — ${result.reason}` : '')
    )

    for (const skip of result.skips ?? []) {
      this.logger.info(`  skip ${skip.asset} ${skip.strategyId}: ${skip.reason}${skip.detail ? ` (${skip.detail})` : ''}`)
    }
    for (const action of result.actions ?? []) {
      this.logger.info(
        `  plan ${action.asset} ${action.strategyId}: ${action.amountNative} (~$${action.amountUsd.toFixed(2)} @ ${action.priceUsd})`
      )
    }
    this.logger.info(
      `  rewards ingested: ${result.rewardsIngested ?? 0}, adopted intents: ${(result.adopted ?? []).length}, executed: ${(result.executed ?? []).length}`
    )
  }
}
