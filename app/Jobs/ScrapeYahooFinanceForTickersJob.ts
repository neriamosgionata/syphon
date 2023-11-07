import {
  BaseJobParameters,
  logMessage,
  progressBarOff,
  progressBarOn,
  progressBarUpdate,
  runJob
} from "App/Services/Jobs/JobHelpers";
import Finance from "@ioc:Providers/Finance";
import Jobs from "@ioc:Providers/Jobs";
import {ImportProfileDataJobParameters} from "App/Jobs/ImportProfileDataJob";
import {ImportChartDataJobParameters} from "App/Jobs/ImportChartDataJob";
import {DateTime} from "luxon";

let progressBarIndex1: number = 0;
let progressBarIndex2: number = 1;

const importTickers = async (tickers: string[]) => {
  logMessage("Importing total tickers data: " + tickers.length, "info");

  progressBarOn(progressBarIndex1, tickers.length, "Importing tickers data...");

  while (tickers.length > 0) {
    const batch = tickers.splice(0, 4);

    let toWait: { id: string; tags: string[]; }[] = [];

    for (const ticker of batch) {
      toWait.push(
        await Jobs.dispatch<ImportProfileDataJobParameters>(
          "ImportProfileDataJob",
          {
            ticker
          },
          ["import-profile-data", ticker]
        )
      );
    }

    await Jobs.waitUntilAllDone(toWait);

    progressBarUpdate(progressBarIndex1, batch.length);

    logMessage("Imported tickers data: " + batch.length, "info");

    logMessage("Waiting 10 seconds before next batch", "info");

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  logMessage("Importing tickers data done", "info");

  progressBarOff(progressBarIndex1);
}

const importCharts = async (tickers: string[]) => {
  logMessage("Importing charts for total tickers: " + tickers.length, "info");

  progressBarOn(progressBarIndex2, tickers.length, "Importing charts...");

  const fromDate = DateTime.fromISO("2010-01-01").toJSDate().getTime();

  while (tickers.length > 0) {
    const batch = tickers.splice(0, 4);

    let toWait: { id: string; tags: string[]; }[] = [];

    for (const ticker of batch) {
      toWait.push(
        await Jobs.dispatch<ImportChartDataJobParameters>(
          "ImportChartDataJob",
          {
            ticker,
            fromDate,
            interval: "1d"
          },
          ["import-chart-data", ticker]
        )
      );
    }

    await Jobs.waitUntilAllDone(toWait);

    progressBarUpdate(progressBarIndex2, batch.length);

    logMessage("Imported charts for tickers: " + batch.length, "info");

    logMessage("Waiting 10 seconds before next batch", "info");

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  logMessage("Importing charts for tickers done", "info");

  progressBarOff(progressBarIndex2);
}

const scrapeYahooFinance = async () => {
  logMessage("Scraping Yahoo Finance for tickers", "info")

  const tickers = await Finance.scrapeYahooFinanceForTickerListEtfs();

  logMessage("Scraping Yahoo Finance for tickers done", "info")

  await importTickers(tickers);
  await importCharts(tickers);
}

const handler = async () => {
  logMessage("Setting up systems..", "info");

  await scrapeYahooFinance();
};

export interface ScrapeYahooFinanceForTickersJobParameters extends BaseJobParameters {

}

export default runJob(handler);
