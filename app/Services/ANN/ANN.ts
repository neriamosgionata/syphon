import {DenseLayerArgs} from "@tensorflow/tfjs-layers/dist/layers/core";
import {ModelCompileArgs} from "@tensorflow/tfjs-layers/dist/engine/training";
import Console from "@ioc:Providers/Console";

import * as tfjs from "@tensorflow/tfjs-node";
import {ModelFitArgs} from "@tensorflow/tfjs-layers/dist/engine/training_tensors";


export interface ANNContract {
  createANN(layersStructure: DenseLayerArgs[], compileOptions: ModelCompileArgs): Promise<tfjs.Sequential>;

  trainANN(model: tfjs.Sequential, xSet: number[][], ySet: number[], args: ModelFitArgs, saveTensorboard?: boolean): Promise<tfjs.History>;

  predictANN(model: tfjs.Sequential, xTestSet: number[][]): tfjs.Tensor<tfjs.Rank> | tfjs.Tensor[];
}

export default class ANN implements ANNContract {

  async createANN(layersStructure: DenseLayerArgs[], compileOptions: ModelCompileArgs): Promise<tfjs.Sequential> {
    const tf = require("@tensorflow/tfjs-node");

    await tf.setBackend("tensorflow");
    await tf.ready();

    Console.log("ANN Structure: " + JSON.stringify(layersStructure));

    Console.log("ANN Compilation options: " + JSON.stringify(compileOptions));

    const model = tf.sequential();

    layersStructure.forEach((layerConfig) => {
      model.add(tf.layers.dense(layerConfig));
    });

    model.compile(compileOptions);

    Console.log("ANN created and compiled");

    return model;
  }

  async trainANN(model: tfjs.Sequential, xSet: number[][], ySet: number[], args: ModelFitArgs, saveTensorboard?: boolean): Promise<tfjs.History> {
    Console.log("ANN fitting arguments: " + JSON.stringify(args));

    if (saveTensorboard) {
      args.callbacks = tfjs.node.tensorBoard("/tmp/ann_logs");
    }

    const history = await model.fit(
      tfjs.tensor2d(xSet),
      tfjs.tensor1d(ySet),
      args,
    );

    Console.log("ANN trained");

    return history;
  }

  predictANN(model: tfjs.Sequential, xTestSet: number[][]): tfjs.Tensor<tfjs.Rank> | tfjs.Tensor[] {
    Console.log("Predicting ANN...");

    const prediction = model.predict(tfjs.tensor2d(xTestSet));

    Console.log("ANN predicted");

    return prediction;
  }

}
