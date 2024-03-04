import {configureJob, loadJobParameters} from "App/Services/Jobs/JobHelpers";
import Scraper from "@ioc:Providers/Scraper";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import NpmPackage from "App/Models/NpmPackage";
import ProgressBar from "@ioc:Providers/ProgressBar";


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
    .setHandlers([
      Scraper.goto(`https://www.npmjs.com/package/${packageName}`),
      Scraper.waitRandom(),
      Scraper.removeGPDR(),
      Scraper.evaluate(evalFunction),
    ])
    .run<{ packageVersion: string | null }>();
}

const handler = async () => {
  const {packageName, progressBarIndex} = loadJobParameters<ScrapeSingleNpmPackageJobParameters>();

  const packageVersion = await scrapeNpmPackage(packageName);

  await upsertNpmPackageVersion(packageName, packageVersion.results.packageVersion);

  await ProgressBar.increment(progressBarIndex);
};

export interface ScrapeSingleNpmPackageJobParameters extends BaseJobParameters {
  packageName: string;
  progressBarIndex: string;
}

export default configureJob(handler);
