import {
  BaseJobParameters,
  logMessage,
  progressBarOff,
  progressBarOn,
  progressBarUpdate,
  registerCallbackToParentMessage,
  runJob
} from "App/Services/Jobs/JobHelpers";
import Finance from "@ioc:Providers/Finance";
import Jobs from "@ioc:Providers/Jobs";
import {ImportProfileDataJobParameters} from "App/Jobs/ImportProfileDataJob";
import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {ImportChartDataJobParameters} from "App/Jobs/ImportChartDataJob";
import {DateTime} from "luxon";

let progressIndex1: number | null = null;
let progressIndex2: number | null = null;

const importTickers = async (tickers: string[]) => {
  logMessage("Importing total tickers data: " + tickers.length, "info");

  progressBarOn(tickers.length, "Importing tickers data...");

  while (progressIndex1 === null) {
  }

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

    progressBarUpdate(progressIndex1 as number, batch.length);

    logMessage("Imported tickers data: " + batch.length, "info");

    logMessage("Waiting 10 seconds before next batch", "info");

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  logMessage("Importing tickers data done", "info");

  progressBarOff(progressIndex1 as number);
}

const importCharts = async (tickers: string[]) => {
  logMessage("Importing charts for total tickers: " + tickers.length, "info");

  progressBarOn(tickers.length, "Importing charts...");

  while (progressIndex2 === null) {
  }

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

    progressBarUpdate(progressIndex2, batch.length);

    logMessage("Imported charts for tickers: " + batch.length, "info");

    logMessage("Waiting 10 seconds before next batch", "info");

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  logMessage("Importing charts for tickers done", "info");

  progressBarOff(progressIndex2);
}

const scrapeYahooFinance = async () => {
  logMessage("Scraping Yahoo Finance for tickers", "info")

  const tickers = await Finance.scrapeYahooFinanceForTickerListEtfs();

  logMessage("Scraping Yahoo Finance for tickers done", "info")

  const p1 = importTickers(tickers);
  const p2 = importCharts(tickers);

  await Promise.all([p1, p2]);
}

const handler = async () => {
  logMessage("Setting up systems..", "info");

  registerCallbackToParentMessage((message) => {
    if (message.status === JobMessageEnum.PROGRESS_BAR_INDEX) {
      progressIndex1 = message.payload.progressIndex;

      if (progressIndex1 !== null) {
        progressIndex2 = message.payload.progressIndex;
      }
    }
  });

  await scrapeYahooFinance();
};

export interface ScrapeYahooFinanceForTickersJobParameters extends BaseJobParameters {

}

export default runJob(handler);
