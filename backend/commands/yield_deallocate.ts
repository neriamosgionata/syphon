import { BaseCommand } from '@adonisjs/core/ace'
import logger from '@adonisjs/core/services/logger'
import YieldAllocation from '#models/YieldAllocation'
import KrakenEarnClient from '#services/KrakenEarnClient'
import KrakenYieldService from '#services/KrakenYieldService'
import { normalizeKrakenAsset } from '#services/YieldPolicy'

// CLI-only liquidity escape hatch: deallocates through the same intent
// machinery (never double-submitted) and verifies the restored balance.

export default class YieldDeallocate extends BaseCommand {
  static commandName = 'yield:deallocate'
  static description = 'Deallocate from a Kraken Earn strategy (CLI-only escape hatch)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'asset', name: 'asset', type: 'string', description: 'Asset to deallocate (e.g. ETH)' },
    { flagName: 'amount', name: 'amount', type: 'number', description: 'Native amount to deallocate' },
    { flagName: 'reason', name: 'reason', type: 'string', description: 'Reason (required, logged)' },
  ]

  private async balanceFor(asset: string): Promise<number | null> {
    try {
      const balances = await KrakenEarnClient.getBalance()
      for (const [code, value] of Object.entries(balances)) {
        if (normalizeKrakenAsset(code) === asset.toUpperCase()) return Number(value) || 0
      }
      return null
    } catch {
      return null
    }
  }

  async run() {
    const asset = this.parsed.flags.asset ? String(this.parsed.flags.asset).toUpperCase() : ''
    const amount = Number(this.parsed.flags.amount ?? 0)
    const reason = this.parsed.flags.reason ? String(this.parsed.flags.reason) : ''

    if (!asset || !Number.isFinite(amount) || amount <= 0 || !reason) {
      logger.error('--asset, --amount (> 0), and --reason are required')
      return
    }

    const row = await YieldAllocation.query()
      .where('asset', asset)
      .orderBy('allocated_native', 'desc')
      .first()
    if (!row) {
      logger.error(`No allocation row for ${asset}`)
      return
    }

    const before = await this.balanceFor(asset)
    logger.info(`Deallocating ${amount} ${asset} from ${row.strategyId} — reason: ${reason}`)

    const outcome = await KrakenYieldService.deallocate(row.strategyId, amount)
    const after = await this.balanceFor(asset)

    logger.info(`Operation ${outcome.intentId} → ${outcome.status}`)
    if (before !== null && after !== null) {
      logger.info(`Balance ${asset}: ${before} → ${after} (delta ${(after - before).toFixed(12)})`)
      if (after < before) logger.warn('Restored balance is below the pre-deallocation balance — verify at the venue')
    } else {
      logger.warn('Balance verification unavailable (Query Funds refused)')
    }
  }
}
