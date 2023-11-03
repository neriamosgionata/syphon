import {BaseCommand} from '@adonisjs/core/build/standalone'
import {JobContract} from "App/Services/Jobs/Jobs";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ScrapeYahooFinanceForTickersJobParameters} from "App/Jobs/ScrapeYahooFinanceForTickersJob";

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

  public async run() {
    const Jobs: JobContract = this.application.container.use(AppContainerAliasesEnum.Jobs);

    await Jobs.waitUntilDone(
      await Jobs.dispatch<ScrapeYahooFinanceForTickersJobParameters>(
        "ScrapeYahooFinanceForTickersJob",
        {}
      )
    );
  }
}
