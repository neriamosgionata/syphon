import { BaseCommand } from '@adonisjs/core/ace'
import OperationAlert from '#models/OperationAlert'

// The only acknowledgment path. CLI-only like every other mutation; alerts
// are never auto-cleared.

export default class AlertsAck extends BaseCommand {
  static commandName = 'alerts:ack'
  static description = 'Acknowledge alerts by id, source, or all (CLI-only)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'id', name: 'id', type: 'number', description: 'Acknowledge one alert by id' },
    { flagName: 'source', name: 'source', type: 'string', description: 'Acknowledge every unacknowledged alert of a source' },
    { flagName: 'all', name: 'all', type: 'boolean', description: 'Acknowledge every unacknowledged alert' },
  ]

  async run() {
    const id = this.parsed.flags.id !== undefined ? Number(this.parsed.flags.id) : undefined
    const source = this.parsed.flags.source ? String(this.parsed.flags.source) : undefined
    const all = Boolean(this.parsed.flags.all)

    if (id === undefined && !source && !all) {
      this.logger.error('Specify --id, --source, or --all')
      this.exitCode = 1
      return
    }

    const count = await OperationAlert.acknowledge({ id, source })
    this.logger.info(`Acknowledged ${count} alert(s)`)
  }
}
