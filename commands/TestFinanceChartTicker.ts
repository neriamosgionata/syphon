import { args, BaseCommand } from "@adonisjs/core/build/standalone";
import Finance from "@ioc:Providers/Finance";

export default class TestFinanceChartTicker extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = "test:ticker_chart";

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

  @args.string({ description: "Ticker", required: true })
  public ticker: string;

  @args.string({ description: "Date", required: true })
  public date: string;

  public async run() {
    console.log(await Finance.getChartViaTicker(this.ticker, this.date));
  }
}
