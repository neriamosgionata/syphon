import {args, BaseCommand} from '@adonisjs/core/build/standalone'
import {ScrapeYahooFinanceForTickersJobParameters} from "App/Jobs/ScrapeYahooFinanceForTickersJob";
import Jobs from "@ioc:Providers/Jobs";

export default class ScrapeYahooFinance extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'scrape:yahoo_finance'

  /**
   * Command description is displayed in the "help" output
   */
  public static description = ''

  public static settings = {
    /**
     * Set the following value to true, if you want to load the application
     * before running the command. Don't forget to call `node ace generate:manifest`
     * afterwards.
     */
    loadApp: true,

    /**
     * Set the following value to true, if you want this command to keep running until
     * you manually decide to exit the process. Don't forget to call
     * `node ace generate:manifest` afterwards.
     */
    stayAlive: false,
  }

  @args.string({description: "Num of threads to use", required: false})
  public numOfThreads: string | undefined;

  public async run() {
    await Jobs.dispatch<ScrapeYahooFinanceForTickersJobParameters>(
      "ScrapeYahooFinanceForTickersJob",
      {
        numOfThreads: this.numOfThreads ? parseInt(this.numOfThreads) : 2
      }
    );
  }
}
