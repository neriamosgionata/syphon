import {BaseCommand} from '@adonisjs/core/build/standalone'
import TickerChart from "App/Models/TickerChart";
import Console from "@ioc:Providers/Console";
import ANN from "@ioc:Providers/ANN";

export default class TestAnn extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'test:ann'

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

    const data = await TickerChart.TickerChartToANNData("2022-01-01");

    const features_length = data.shape[1];

    Console.log(`Data features length: ${features_length}`);

    Console.log("Running ANN training...");

    const ann = ANN.createANN(
      [
        {
          units: features_length,
          activation: "relu",
        },
        {
          units: features_length,
          activation: "relu",
        },
        {
          units: features_length,
          activation: "relu",
        },
        {
          units: features_length,
          activation: "relu",
        },
        {
          units: 1,
          activation: "sigmoid"
        },
      ],
      {
        loss: "binary_crossentropy",
        optimizer: "adam",
        metrics: ["accuracy"],
      },
    );

    const _history = await ann.fit(
      data,
      data,
      {
        batchSize: 32,
        epochs: 10000,
      },
    );

    Console.log(_history);

    Console.log("Running ANN training... Done");
  }
}
