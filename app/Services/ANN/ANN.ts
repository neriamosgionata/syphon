import * as tf from "@tensorflow/tfjs-node";
import {DenseLayerArgs} from "@tensorflow/tfjs-layers/dist/layers/core";
import {ModelCompileArgs} from "@tensorflow/tfjs-layers/dist/engine/training";
import Console from "@ioc:Providers/Console";

export interface ANNContract {
  createANN(layersStructure: DenseLayerArgs[], compileOptions: ModelCompileArgs): Promise<tf.Sequential>;

  calculateBatchSizeFromNumberOfSamples(numberOfSamples: number): number;
}

export default class ANN implements ANNContract {

  async createANN(layersStructure: DenseLayerArgs[], compileOptions: ModelCompileArgs): Promise<tf.Sequential> {
    await tf.setBackend("tensorflow");
    await tf.ready();

    Console.log("Tensorflow version: " + JSON.stringify(tf.version));

    Console.log("Creating ANN with backend: " + tf.getBackend());

    const model = tf.sequential();

    layersStructure.forEach((layerConfig) => {
      model.add(tf.layers.dense(layerConfig));
    });

    model.compile(compileOptions);

    Console.log("ANN created and compiled");

    return model;
  }

  calculateBatchSizeFromNumberOfSamples(numberOfSamples: number): number {
    return numberOfSamples > 500000 ? Math.floor(numberOfSamples / 5) : numberOfSamples;
  }

}
