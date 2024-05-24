import {BaseCommand} from '@adonisjs/core/build/standalone'
import TickerChart from "App/Models/TickerChart";
import Console from "@ioc:Providers/Console";
import Profile from "App/Models/Profile";
import Drive from "@ioc:Adonis/Core/Drive";

export default class TestAnn extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'create:test_csv'

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
    Console.log("Loading data...");

    const profile = await Profile.all();

    const tickers = profile.map((p) => p.ticker);

    const data = await TickerChart.TickerChartToANNData("2024-04-23", undefined, tickers);

    await Drive.put('export/test.csv', data.toCSV({
      header: true,
      sep: ',',
    }));
  }
}
