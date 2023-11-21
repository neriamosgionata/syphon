import {configureJob} from "App/Services/Jobs/JobHelpers";
import Logger from "@ioc:Providers/Logger";
import Scraper from "@ioc:Providers/Scraper";
import NpmPackage from "App/Models/NpmPackage";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {DateTime} from "luxon";
import Helper from "@ioc:Providers/Helper";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";


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

const evalFunction = () => {
  const h3Version = [...document.querySelectorAll("h3")]
    .filter((el) => el.textContent === "Version");

  if (h3Version.length === 0) {
    return {packageVersion: null};
  }

  const version = h3Version[0].nextElementSibling?.textContent;

  if (!version) {
    return {packageVersion: null};
  }

  return {packageVersion: version};
}

const scrapeNpmPackage = async (packageName: string) => {
  return await Scraper
    .setScraperStatusName("newsletter-get-single-article")
    .setWithAdblockerPlugin(true)
    .setWithStealthPlugin(true)
    .setHandlers([
      Scraper.goto(`https://www.npmjs.com/package/${packageName}`),
      Scraper.waitRandom(),
      Scraper.removeGPDR(),
      Scraper.evaluate(evalFunction),
    ])
    .run<{ packageVersion: string | null }>();
}

const scrapeNpmRegistryJob = async () => {
  Logger.info("Loading installed packages..");
  let packageNames = Helper.loadInstalledPackageNames();

  Logger.info("Loaded packages: " + packageNames.length);
  packageNames = await verifyPackageToSearch(packageNames);

  Logger.info("Packages to search: " + packageNames.length);
  ProgressBar.newBar(packageNames.length, "Scraping packages");

  Logger.table(packageNames);

  for (const packageName of packageNames) {
    Logger.info("Scraping package: " + packageName);
    const packageVersion = await scrapeNpmPackage(packageName);

    Logger.info("Package version: " + packageVersion.results.packageVersion);
    await upsertNpmPackageVersion(packageName, packageVersion.results.packageVersion);

    ProgressBar.increment();
  }

  ProgressBar.finish();
}

const handler = async () => {
  await scrapeNpmRegistryJob();
};

export interface ScrapeNpmRegistryJobParameters extends BaseJobParameters {

}

export default configureJob(handler);
