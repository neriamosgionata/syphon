import * as tf from '@tensorflow/tfjs-node';
import {DenseLayerArgs} from "@tensorflow/tfjs-layers/dist/layers/core";
import {ModelCompileArgs} from "@tensorflow/tfjs-layers/dist/engine/training";

export interface ANNContract {
  createANN(layersStructure: DenseLayerArgs[], compileOptions: ModelCompileArgs): tf.Sequential;
}

export default class ANN implements ANNContract {

  createANN(layersStructure: DenseLayerArgs[], compileOptions: ModelCompileArgs): tf.Sequential {
    const model = tf.sequential();

    layersStructure.forEach((layerConfig) => {
      model.add(tf.layers.dense(layerConfig));
    });

    model.compile(compileOptions);

    return model;
  }

}
