import { BaseCommand } from '@adonisjs/core/ace'
import { buildYieldStatus } from '#services/YieldReport'

export default class YieldStatus extends BaseCommand {
  static commandName = 'yield:status'
  static description = 'Show Kraken Earn allocations, realized rewards, operations, and alerts'
  static options = { startApp: true }

  static flags = [
    { flagName: 'json', name: 'json', type: 'boolean', description: 'Emit JSON' },
  ]

  async run() {
    const status = await buildYieldStatus()

    if (this.parsed.flags.json) {
      this.logger.info(JSON.stringify(status, null, 2))
      return
    }

    this.logger.info('')
    this.logger.info(
      `Last tick: ${status.lastTick.at ? new Date(status.lastTick.at).toISOString() : 'never'}` +
        `${status.lastTick.stale ? '  [STALE]' : ''}`
    )
    this.logger.info(
      `Preflight: ${status.preflight.state ?? 'none'}${status.preflight.at ? ` at ${new Date(status.preflight.at).toISOString()}` : ''}` +
        `${status.preflight.fresh ? '' : '  [NOT FRESH]'}`
    )

    this.logger.info('')
    this.logger.info('Allocations:')
    if (status.allocations.length === 0) this.logger.info('  (none)')
    for (const allocation of status.allocations) {
      const unbonding = allocation.unbondingExpiresAt
        ? ` unbonding ${allocation.unbondingNative} until ${new Date(allocation.unbondingExpiresAt).toISOString()}`
        : ''
      this.logger.info(
        `  ${String(allocation.asset).padEnd(6)} ${String(allocation.strategyId).padEnd(20)} ${String(allocation.lockType).padEnd(8)} ` +
          `allocated ${allocation.allocatedNative}${unbonding}  apy ${allocation.apyLow ?? '—'}-${allocation.apyHigh ?? '—'}`
      )
    }

    this.logger.info('')
    this.logger.info(`Open operations: ${status.openOperations.length}`)
    for (const operation of status.openOperations) {
      this.logger.info(`  #${operation.id} ${operation.type} ${operation.strategyId} ${operation.status} (${operation.refid ?? 'no refid'})`)
    }

    this.logger.info('')
    this.logger.info('Realized rewards (30d):')
    if (status.realized.length === 0) this.logger.info('  (none)')
    for (const entry of status.realized) {
      this.logger.info(`  ${entry.asset}: ${entry.amount} over ${entry.rewards} payout(s)`)
    }

    this.logger.info('')
    this.logger.info('Recent alerts:')
    if (status.recentAlerts.length === 0) this.logger.info('  (none)')
    for (const alert of status.recentAlerts) {
      this.logger.info(
        `  #${alert.id} ${alert.severity} ${alert.code}${alert.acknowledgedAt ? '' : ' [unacknowledged]'} — ${alert.message}`
      )
    }
  }
}
