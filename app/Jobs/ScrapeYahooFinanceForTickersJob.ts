import {configureJob, loadJobParameters} from "App/Services/Jobs/JobHelpers";
import Finance from "@ioc:Providers/Finance";
import Jobs from "@ioc:Providers/Jobs";
import {ImportProfileDataJobParameters} from "App/Jobs/ImportProfileDataJob";
import {ImportChartDataJobParameters} from "App/Jobs/ImportChartDataJob";
import {DateTime} from "luxon";
import Log from "@ioc:Providers/Logger";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Profile from "App/Models/Profile";

const importTickers = async (tickers: string[], numOfThreads: number) => {
  await Log.info("Importing total tickers data: " + tickers.length);

  for (const tickerIndex in tickers) {
    let ticker = tickers[tickerIndex];

    const lastIndex = await Profile
      .query()
      .where("ticker", ticker)
      .where("index_date", ">", new Date(Date.now() - (15 * 24 * 60 * 60 * 1000)))
      .orderBy("index_date", "desc")
      .first();

    if (!lastIndex) {
      continue;
    }

    tickers.splice(parseInt(tickerIndex), 1);
  }

  const index = await ProgressBar.newBar(tickers.length, "Importing tickers data...");

  while (tickers.length > 0) {
    const batch = tickers.splice(0, numOfThreads);

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

    await ProgressBar.increment(index, batch.length);

    await Log.info("Imported tickers data for: " + batch);
  }

  await Log.info("Importing tickers data done");
}

const importCharts = async (tickers: string[], numOfThreads: number) => {
  await Log.info("Importing charts for total tickers: " + tickers.length);

  const index = await ProgressBar.newBar(tickers.length, "Importing charts...");

  const fromDate = DateTime.fromISO("2010-01-01").toJSDate().getTime();

  while (tickers.length > 0) {
    const batch = tickers.splice(0, numOfThreads);

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

    await ProgressBar.increment(index, batch.length);

    await Log.info("Imported tickers charts for: " + batch);
  }

  await Log.info("Importing charts for tickers done");
}

const scrapeYahooFinance = async (numOfThreads: number) => {
  await Log.info("Scraping Yahoo Finance for tickers");

  const tickers = await Finance.scrapeYahooFinanceForTickerListEtfs();

  await Log.info("Scraping Yahoo Finance for tickers done");

  await importTickers([...tickers], numOfThreads);
  await importCharts([...tickers], numOfThreads);

  await ProgressBar.finishAll();
}

const handler = async () => {
  let {numOfThreads} = loadJobParameters<ScrapeYahooFinanceForTickersJobParameters>();
  numOfThreads ??= 1;
  await scrapeYahooFinance(numOfThreads);
};

export interface ScrapeYahooFinanceForTickersJobParameters extends BaseJobParameters {
  numOfThreads?: number;
}

export default configureJob(handler);
