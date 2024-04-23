/**
 * Contract source: https://git.io/JBt3I
 *
 * Feel free to let us know via PR, if you find something broken in this contract
 * file.
 */

import '@ioc:Adonis/Core/Drive';
import type {InferDisksFromConfig} from '@adonisjs/core/build/config';
import type driveConfig from '../config/drive';
import {
  LocalStorageDriverConfig,
  LocalStorageDriverContract
} from "App/Services/LocalStorageDriver/LocalStorageDriverService";

declare module '@ioc:Adonis/Core/Drive' {
  interface DriversList {
    local: {
      implementation: LocalDriverContract;
      config: LocalDriverConfig;
    },
    "local-storage": {
      config: LocalStorageDriverConfig,
      implementation: LocalStorageDriverContract
    },
  }

  interface DisksList extends InferDisksFromConfig<typeof driveConfig> {
    "local-storage": {
      config: LocalStorageDriverConfig,
      implementation: LocalStorageDriverContract
    }
  }
}
