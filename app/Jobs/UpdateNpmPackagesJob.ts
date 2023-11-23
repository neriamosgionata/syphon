import {configureJob, loadJobParameters} from "App/Services/Jobs/JobHelpers";
import util from "util";
import {exec} from "child_process";
import Console from "@ioc:Providers/Console";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";

const updatePackage = async (name: string, version: string) => {
  try {
    await util.promisify(exec)('npm install ' + name + '@' + version + ' --save');
  } catch (err) {
    Console.error(err);
  }
}

const handler = async () => {
  let {npmPackages} = loadJobParameters<UpdateNpmPackagesJobParameters>();

  for (const npmPackage of npmPackages) {
    Console.log("Updating package '" + npmPackage.name + "' to version '" + npmPackage.version + "'");
    await updatePackage(npmPackage.name, npmPackage.version);
  }
};

export interface UpdateNpmPackagesJobParameters extends BaseJobParameters {
  npmPackages: { "current version": string, status: string, name: string, version: string }[];
}

export default configureJob(handler);
