import {configureJob, loadJobParameters, messageToParent} from "App/Services/Jobs/JobHelpers";
import Scraper from "@ioc:Providers/Scraper";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";

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

const handler = async () => {
  const {packageName} = loadJobParameters<ScrapeSingleNpmPackageJobParameters>();
  const packageVersion = await scrapeNpmPackage(packageName);
  messageToParent({
    packageName,
    packageVersion: packageVersion.results.packageVersion,
  });
};

export interface ScrapeSingleNpmPackageJobParameters extends BaseJobParameters {
  packageName: string;
}

export default configureJob(handler);
