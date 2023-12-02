import Finance from "@ioc:Providers/Finance";
import TickerChart from "App/Models/TickerChart";
import {ChartResultArray, ChartResultArrayQuote} from "yahoo-finance2/dist/esm/src/modules/chart";
import {configureJob, loadJobParameters} from "App/Services/Jobs/JobHelpers";
import {ChartInterval} from "App/Services/Finance/Finance";
import Logger from "@ioc:Providers/Logger";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";
import {DateTime} from "luxon";

const createChartEntry = async (
  ticker: string,
  entry: ChartResultArrayQuote,
  interval: ChartInterval
) => {
  await TickerChart.create(
    TickerChart.createObjectFromYahoo(ticker, interval, entry)
  );
};

const importElementsFromFinance = async (ticker: string, chart: ChartResultArray, interval: ChartInterval) => {
  const elements = chart.quotes.reverse();

  const lastTicker = await TickerChart
    .query()
    .where("ticker", ticker)
    .where("interval", interval)
    .orderBy("date", "desc")
    .first();

  if (!lastTicker) {
    for (const row of elements) {
      await createChartEntry(ticker, row, interval);
    }
    return;
  }

  const lastDate = lastTicker.date as DateTime;
  const lastDateIndex = elements.findIndex((el) => el.date.getTime() < lastDate.toJSDate().getTime());

  if (lastDateIndex === -1) {
    for (const row of elements) {
      await createChartEntry(ticker, row, interval);
    }
    return;
  }

  for (const row of elements.slice(lastDateIndex + 1)) {
    await createChartEntry(ticker, row, interval);
  }
};

const handler = async () => {
  const parameters = loadJobParameters<ImportChartDataJobParameters>();

  if (!Array.isArray(parameters.ticker)) {
    parameters.ticker = [parameters.ticker];
  }

  for (const ticker of parameters.ticker) {
    try {
      await importElementsFromFinance(
        ticker,
        await Finance.getChartViaTicker(ticker, parameters.fromDate, undefined, parameters.interval),
        parameters.interval
      );
    } catch (e) {
      Logger.error(`Error importing chart data for ${ticker}: ${e.message}`);
    }
  }
};

export interface ImportChartDataJobParameters extends BaseJobParameters {
  ticker: string | string[];
  fromDate: string | number;
  interval: ChartInterval;
}

export default configureJob(handler);
