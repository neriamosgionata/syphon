import {BaseCommand} from '@adonisjs/core/build/standalone'
import TickerChart from "App/Models/TickerChart";
import Console from "@ioc:Providers/Console";
import ANN from "@ioc:Providers/ANN";
import * as dfd from "danfojs-node";
import {ConfusionMatrix} from "ml-confusion-matrix";
import Profile from "App/Models/Profile";
import {train_test_split} from "machinelearn/model_selection";
import {Rank, Tensor} from "@tensorflow/tfjs-core";

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

    const tickers = (await Profile.all()).map((p) => p.ticker);

    Console.log("Analysing Tickers: " + tickers.length);

    const data = await TickerChart.TickerChartToANNData("2022-01-01", undefined, tickers);

    const dataSampleLength = data.shape[0];
    const dataFeaturesLength = data.shape[1];

    Console.log(`Data samples length: ${dataSampleLength}`);
    Console.log(`Data features length: ${dataFeaturesLength}`);

    Console.log("Preparing dataset...");

    const x_set = data.iloc({columns: ["0:" + (dataFeaturesLength - 2)]}).values as number[][];
    const y_set = data.iloc({columns: [(dataFeaturesLength - 2) + ":" + (dataFeaturesLength - 1)]}).values.map((v: any) => v[0]) as number[];

    Console.log("Splitting dataset...");

    const res = train_test_split(
      x_set,
      y_set,
      {
        test_size: 0.2,
        train_size: 0.8,
        random_state: 42,
        clone: true,
      }
    );

    let x_train = res.xTrain as number[][];
    let y_train = res.yTrain as number[];

    let x_test = res.xTest as number[][];
    let y_test = res.yTest as number[];

    Console.log("Normalizing dataset...");

    const standardScaler = new dfd.StandardScaler();
    x_train = standardScaler.fitTransform(x_train);
    x_test = standardScaler.transform(x_test);

    for (const a in x_train) {
      for (const b in x_train[a]) {
        if (isNaN(x_train[a][b])) {
          x_train[a][b] = 0;
        }
      }
    }

    for (const a in x_test) {
      for (const b in x_test[a]) {
        if (isNaN(x_test[a][b])) {
          x_test[a][b] = 0;
        }
      }
    }

    Console.log("Dataset ready");

    Console.log("Preparing ANN...");

    const configuredAnn = await ANN.createANN(
      [
        {
          units: dataFeaturesLength,
          activation: "relu",
          batchInputShape: [x_train.length, x_train[0].length],
        },
        {
          units: dataFeaturesLength,
          activation: "relu"
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

    Console.log("Running ANN training...");

    const history = await ANN.trainANN(
      configuredAnn,
      x_train,
      y_train,
      {
        batchSize: 50,
        epochs: 100,
        verbose: 1,
      },
      true
    );

    Console.log("Training history: ", history);

    Console.log("Predicting next results...");

    const y_pred = ANN.predictANN(configuredAnn, x_test) as Tensor<Rank>;

    Console.log(y_pred, y_test);

    const cm = ConfusionMatrix.fromLabels(y_test, y_pred.arraySync() as number[]);

    Console.log("Accuracy: " + cm.getAccuracy());

    Console.log("Running ANN training... Done");
  }
}
