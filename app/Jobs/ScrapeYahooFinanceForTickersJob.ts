import {configureJob} from "App/Services/Jobs/JobHelpers";
import Finance from "@ioc:Providers/Finance";
import Jobs from "@ioc:Providers/Jobs";
import {ImportProfileDataJobParameters} from "App/Jobs/ImportProfileDataJob";
import {ImportChartDataJobParameters} from "App/Jobs/ImportChartDataJob";
import {DateTime} from "luxon";
import Logger from "@ioc:Providers/Logger";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";

let progressBarIndex1: number = 0;
let progressBarIndex2: number = 1;

const importTickers = async (tickers: string[]) => {
  Logger.info("Importing total tickers data: " + tickers.length);

  ProgressBar.newBar(tickers.length, "Importing tickers data...", progressBarIndex1);

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

    ProgressBar.increment(progressBarIndex1, batch.length);

    Logger.info("Imported tickers data: " + batch.length);

    Logger.info("Waiting 10 seconds before next batch");

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  Logger.info("Importing tickers data done");

  ProgressBar.finish(progressBarIndex1);
}

const importCharts = async (tickers: string[]) => {
  Logger.info("Importing charts for total tickers: " + tickers.length);

  ProgressBar.newBar(tickers.length, "Importing charts...", progressBarIndex2);

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

    ProgressBar.increment(progressBarIndex2, batch.length);

    Logger.info("Imported charts for tickers: " + batch.length);

    Logger.info("Waiting 10 seconds before next batch");

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  Logger.info("Importing charts for tickers done");

  ProgressBar.finish(progressBarIndex2);
}

const scrapeYahooFinance = async () => {
  Logger.info("Scraping Yahoo Finance for tickers");

  const tickers = await Finance.scrapeYahooFinanceForTickerListEtfs();

  Logger.info("Scraping Yahoo Finance for tickers done");

  await importTickers([...tickers]);
  await importCharts([...tickers]);
}

const handler = async () => {


  await scrapeYahooFinance();
};

export interface ScrapeYahooFinanceForTickersJobParameters extends BaseJobParameters {

}

export default configureJob(handler);
