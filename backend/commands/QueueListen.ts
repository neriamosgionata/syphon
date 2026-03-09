import { BaseCommand } from '@adonisjs/core/build/standalone'

export default class QueueListen extends BaseCommand {
  public static commandName = 'queue:listen'
  public static description = 'Start the BullMQ workers'

  public async run() {
    const { registerScrapeNewsWorker } = await import('App/Jobs/ScrapeNewsJob')
    const { registerAnalyzeArticleWorker } = await import('App/Jobs/AnalyzeArticleJob')
    const { registerFetchTickerWorker } = await import('App/Jobs/FetchTickerJob')

    registerScrapeNewsWorker()
    registerAnalyzeArticleWorker()
    registerFetchTickerWorker()

    this.logger.info('BullMQ workers are running. Press CTRL+C to stop.')

    // Keep the process alive
    await new Promise(() => {})
  }
}
