import { BaseCommand } from '@adonisjs/core/ace'
import TickRecorderService from '#services/TickRecorderService'
import AlgoConfig from '#models/AlgoConfig'

export default class KrakenRecord extends BaseCommand {
  static commandName = 'kraken:record'
  static description = 'Record live Kraken WS trades into 1s tick_records bars for N hours'
  static options = { startApp: true }

  static flags = [
    { flagName: 'hours', name: 'hours', type: 'number', description: 'Recording duration in hours (default 2)' },
  ]

  async run() {
    const hours = Number(this.parsed.flags.hours || 2)
    const config = await AlgoConfig.getConfig()
    const symbols = config.fastWatchlist.length > 0 ? config.fastWatchlist : ['BTC', 'ETH', 'SOL']

    if (TickRecorderService.running) {
      this.logger.info(`[KrakenRecord] Recorder already running for ${TickRecorderService.status().symbols.join(', ')}`)
      return
    }

    TickRecorderService.start(symbols)
    this.logger.info(`[KrakenRecord] Recording ${symbols.join(', ')} for ${hours}h (flush every 10s)`)

    const deadline = Date.now() + hours * 3600_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30_000))
      const s = TickRecorderService.status()
      this.logger.info(`[KrakenRecord] ${new Date().toISOString()} — buffered bars: ${JSON.stringify(s.bufferedBars)}`)
    }

    await TickRecorderService.flush()
    TickRecorderService.stop()
    this.logger.info('[KrakenRecord] Done. Rows in tick_records now cover the window.')
  }
}