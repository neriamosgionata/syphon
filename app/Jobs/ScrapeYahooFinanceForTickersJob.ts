import {configureJob} from "App/Services/Jobs/JobHelpers";
import Finance from "@ioc:Providers/Finance";
import Jobs from "@ioc:Providers/Jobs";
import {ImportProfileDataJobParameters} from "App/Jobs/ImportProfileDataJob";
import {ImportChartDataJobParameters} from "App/Jobs/ImportChartDataJob";
import {DateTime} from "luxon";
import Logger from "@ioc:Providers/Logger";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";
import Profile from "App/Models/Profile";

const importTickers = async (tickers: string[]) => {
  Logger.info("Importing total tickers data: " + tickers.length);

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

  ProgressBar.newBar(tickers.length, "Importing tickers data...", 0);

  while (tickers.length > 0) {
    const batch = tickers.splice(0, 2);

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

    ProgressBar.increment(0, batch.length);

    Logger.info("Imported tickers data for: " + batch);
  }

  Logger.info("Importing tickers data done");
}

const importCharts = async (tickers: string[]) => {
  Logger.info("Importing charts for total tickers: " + tickers.length);

  ProgressBar.newBar(tickers.length, "Importing charts...", 1);

  const fromDate = DateTime.fromISO("2010-01-01").toJSDate().getTime();

  while (tickers.length > 0) {
    const batch = tickers.splice(0, 2);

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

    ProgressBar.increment(1, batch.length);

    Logger.info("Imported tickers charts for: " + batch);
  }

  Logger.info("Importing charts for tickers done");
}

const scrapeYahooFinance = async () => {
  Logger.info("Scraping Yahoo Finance for tickers");

  const tickers = await Finance.scrapeYahooFinanceForTickerListEtfs();

  Logger.info("Scraping Yahoo Finance for tickers done");

  await importTickers([...tickers]);
  await importCharts([...tickers]);

  ProgressBar.finishAll();
}

const handler = async () => {
  await scrapeYahooFinance();
};

export interface ScrapeYahooFinanceForTickersJobParameters extends BaseJobParameters {

}

export default configureJob(handler);
