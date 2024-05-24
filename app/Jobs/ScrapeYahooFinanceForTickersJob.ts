import {configureJob} from "App/Services/Jobs/JobHelpers";
import Finance from "@ioc:Providers/Finance";
import {DateTime} from "luxon";
import Log from "@ioc:Providers/Logger";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Profile from "App/Models/Profile";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import {ChartResultArray, ChartResultArrayQuote} from "yahoo-finance2/dist/esm/src/modules/chart";
import {ChartInterval} from "App/Services/Finance/Finance";
import TickerChart from "App/Models/TickerChart";

const createChartEntry = async (
  ticker: string,
  entry: ChartResultArrayQuote,
  interval: ChartInterval
) => {
  const partial = TickerChart.createObjectFromYahoo(ticker, interval, entry);

  await TickerChart.create(partial);
};

const importElementsFromFinance = async (ticker: string, chart: ChartResultArray, interval: ChartInterval) => {
  const elements = chart.quotes;

  for (const row of elements) {
    try {
      await createChartEntry(ticker, row, interval);
    } catch (e) {
      await Log.error(`Error importing chart data for ${ticker}: ${e.message}`);
    }
  }
};

const importCharts = async (tickers: string[]) => {
  await Log.info("Importing charts for total tickers: " + tickers.length);

  const index = await ProgressBar.newBar(tickers.length, "Importing charts...");

  const fromDate = DateTime.fromISO("2010-01-01").toJSDate().getTime();

  for (const ticker of tickers) {
    await Log.info(`Importing chart data for ${ticker}`);

    try {
      await importElementsFromFinance(
        ticker,
        await Finance.getChartViaTicker(ticker, fromDate, undefined, "1d"),
        "1d"
      );
    } catch (e) {
      await Log.error(`Error importing chart data for ${ticker}: ${e.message}`);
    }

    await ProgressBar.increment(index);
  }

  await Log.info("Importing charts for tickers done");
}

const updateProfile = async (ticker: string, profile: Quote) => {
  await Profile.create(
    Profile.createObjectFromYahoo(ticker, profile)
  );
}

const importQuoteFromFinance = async (ticker: string) => {
  await updateProfile(ticker, await Finance.getQuoteViaTicker(ticker));
}

const importTickers = async (tickers: string[]) => {
  await Log.info("Importing total tickers data: " + tickers.length);

  const index = await ProgressBar.newBar(tickers.length, "Importing tickers data...");

  for (const ticker of tickers) {
    await Log.info(`Importing ticker data for ${ticker}`);

    try {
      await importQuoteFromFinance(ticker);
    } catch (e) {
      await Log.error(`Error importing ticker data for ${ticker}: ${e.message}`);
    }

    await ProgressBar.increment(index);
  }

  await Log.info("Importing tickers data done");
}

const scrapeYahooFinance = async () => {
  await Log.info("Scraping Yahoo Finance for tickers");

  const tickers = await Finance.scrapeYahooFinanceForTickerListEtfs();

  await Log.info("Scraping Yahoo Finance for tickers done");

  await importTickers([...tickers]);
  await importCharts([...tickers]);

  await ProgressBar.finishAll();
}

const handler = async () => {
  await scrapeYahooFinance();
};

export interface ScrapeYahooFinanceForTickersJobParameters extends BaseJobParameters {
}

export default configureJob(handler);
