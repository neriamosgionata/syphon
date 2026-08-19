import { BaseCommand } from '@adonisjs/core/ace'

export default class QueueListen extends BaseCommand {
  static commandName = 'queue:listen'
  static description = 'Start the BullMQ workers'

  async run() {
    const { registerScrapeNewsWorker } = await import('#jobs/ScrapeNewsJob')
    const { registerAnalyzeArticleWorker } = await import('#jobs/AnalyzeArticleJob')
    const { registerFetchTickerWorker } = await import('#jobs/FetchTickerJob')
    const { registerSubmitOrderWorker } = await import('#jobs/SubmitOrderJob')
    const { registerMonitorOrderWorker } = await import('#jobs/MonitorOrderJob')
    const { registerBackfillNewsWorker } = await import('#jobs/BackfillNewsJob')
    const { registerAlgoTradingWorker } = await import('#jobs/AlgoTradingJob')

    registerScrapeNewsWorker()
    registerAnalyzeArticleWorker()
    registerFetchTickerWorker()
    registerSubmitOrderWorker()
    registerMonitorOrderWorker()
    registerBackfillNewsWorker()
    registerAlgoTradingWorker()

    this.logger.info('BullMQ workers are running. Press CTRL+C to stop.')

    // Keep the process alive
    await new Promise(() => {})
  }
}