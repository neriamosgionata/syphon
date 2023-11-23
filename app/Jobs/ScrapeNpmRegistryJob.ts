import {configureJob} from "App/Services/Jobs/JobHelpers";
import Logger from "@ioc:Providers/Logger";
import NpmPackage from "App/Models/NpmPackage";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {DateTime} from "luxon";
import Helper from "@ioc:Providers/Helper";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";
import Jobs from "@ioc:Providers/Jobs";
import Console from "@ioc:Providers/Console";

const upsertNpmPackageVersion = async (packageName: string, packageVersion: string | null) => {
  const res = await NpmPackage
    .query()
    .where("name", packageName)
    .update({
      lastVersion: packageVersion,
    })
    .exec()

  if (res.length === 0 || res[0] === 0) {
    await NpmPackage.create({
      name: packageName,
      lastVersion: packageVersion,
    });
  }
}

const verifyPackageToSearch = async (packageNames: string[]) => {
  const nowMinus1Week = DateTime.now().minus({weeks: 1}).endOf('day').toISO() as string;

  const results = await NpmPackage
    .query()
    .whereIn("name", packageNames)
    .where((q) => {
      q.whereNotNull("last_version")
      q.andWhere("updated_at", ">=", nowMinus1Week)
    })
    .exec()

  return packageNames.filter((packageName) => results.findIndex((result) => result.name === packageName) === -1);
}

const scrapeNpmPackages = async (packageNames: string[]) => {
  let results: { packageName: string, packageVersion: string | null }[] = [];

  const promises = packageNames
    .map((packageName) =>
      Jobs.dispatch(
        "ScrapeSingleNpmPackageJob",
        {
          packageName,
        },
        [],
        (payload) => {
          results.push({
            packageName,
            packageVersion: payload.payload.packageVersion,
          });
          ProgressBar.increment();
        }
      )
    );

  await Jobs.waitUntilAllDone(await Promise.all(promises));

  for (const result of results) {
    await upsertNpmPackageVersion(result.packageName, result.packageVersion);
  }
}

const scrapeNpmRegistryJob = async () => {
  Logger.info("Loading installed packages..");
  let packageNames = Helper.loadInstalledPackageNames();

  Logger.info("Loaded packages: " + packageNames.length);
  packageNames = await verifyPackageToSearch(packageNames);

  Logger.info("Packages to search: " + packageNames.length);
  ProgressBar.newBar(packageNames.length, "Scraping packages");

  Logger.table(packageNames);

  Console.log("Scraping packages...");

  while (packageNames.length > 0) {
    const packageNamesToSearch = packageNames.splice(0, 4);
    await scrapeNpmPackages(packageNamesToSearch);
  }

  ProgressBar.finish();
}

const handler = async () => {
  await scrapeNpmRegistryJob();
};

export interface ScrapeNpmRegistryJobParameters extends BaseJobParameters {

}

export default configureJob(handler);
