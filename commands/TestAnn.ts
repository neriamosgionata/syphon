import {BaseCommand} from '@adonisjs/core/build/standalone'
import TickerChart from "App/Models/TickerChart";
import Console from "@ioc:Providers/Console";
import ANN from "@ioc:Providers/ANN";
import * as dfd from "danfojs-node";
import {model_selection} from "machinelearn";
import {ConfusionMatrix} from "ml-confusion-matrix";
import Profile from "App/Models/Profile";
import type {ArrayType2D} from "danfojs-node/dist/danfojs-base/shared/types";

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

    const profile = await Profile.all();

    const first_100_ticks = profile.map((p) => p.ticker).slice(0, 100);

    const data = await TickerChart.TickerChartToANNData("2022-01-01", undefined, first_100_ticks);

    const dataSampleLength = data.shape[0];
    const dataFeaturesLength = data.shape[1];

    Console.log(`Data samples length: ${dataSampleLength}`);
    Console.log(`Data features length: ${dataFeaturesLength}`);

    Console.log("Running ANN training...");

    const ann = ANN.createANN(
      [
        {
          units: dataFeaturesLength,
          activation: "relu",
          batchInputShape: [null, dataFeaturesLength],
        },
        {
          units: dataFeaturesLength + 2,
          activation: "relu",
        },
        {
          units: dataFeaturesLength + 2,
          activation: "relu",
        },
        {
          units: dataFeaturesLength + 2,
          activation: "relu",
        },
        {
          units: dataFeaturesLength + 2,
          activation: "relu",
        },
        {
          units: dataFeaturesLength + 2,
          activation: "relu",
        },
        {
          units: 1,
          activation: "sigmoid"
        },
      ],
      {
        loss: "meanSquaredError",
        optimizer: "adam",
        metrics: ["accuracy"],
      },
    );

    Console.log("Preparing dataset...");

    const x_set = data.iloc({columns: ["0:" + (dataFeaturesLength - 2)]}).values as ArrayType2D;
    const y_set = data.iloc({columns: [":" + (dataFeaturesLength - 1)]}).values as ArrayType2D;

    Console.log("Splitting dataset...");

    const res = model_selection.train_test_split(
      x_set,
      y_set,
    );

    let x_train = res.xTrain;
    let x_test = res.xTest;
    let y_train = res.yTrain;
    let y_test = res.yTest;

    Console.log("Normalizing dataset...");

    const standardScaler = new dfd.StandardScaler();

    x_train = standardScaler.fitTransform(x_train);
    x_test = standardScaler.transform(x_test);

    Console.log("Fitting ANN...");

    const _history = await ann.fit(
      x_train,
      y_train,
      {
        batchSize: ANN.calculateBatchSizeFromNumberOfSamples(dataSampleLength),
        epochs: 1000,
        verbose: 1,
      },
    );

    Console.log(_history);

    Console.log("Predicting next results...");

    const y_pred = ann.predict(x_test);

    Console.log("Predicted results:");

    Console.log(y_pred);

    const cm = ConfusionMatrix.fromLabels(y_test as any, y_pred as any);

    Console.log("Accuracy: " + cm.getAccuracy());

    Console.log("Running ANN training... Done");
  }
}
