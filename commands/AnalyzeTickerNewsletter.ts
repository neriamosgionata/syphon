import {args, BaseCommand} from "@adonisjs/core/build/standalone";
import {AnalyzeNewsletterForTickerJobParameters} from "App/Jobs/AnalyzeNewsletterForTickerJob";
import Jobs from "@ioc:Providers/Jobs";

export default class AnalyzeTickerNewsletter extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = "analyze:ticker_newsletter";

  /**
   * Command description is displayed in the "help" output
   */
  public static description = "";

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
     * `node ace generate:manifest` afterward.
     */
    stayAlive: false
  };

  @args.string({description: "Ticker", required: true})
  public ticker: string;

  public async run() {
    //RUN GOOGLE NEWS SCRAPING

    await Jobs.waitUntilDone(
      await Jobs.dispatch<AnalyzeNewsletterForTickerJobParameters>(
        "AnalyzeNewsletterForTickerJob",
        {
          ticker: this.ticker,
        },
        [],
      ),
    );
  }
}
