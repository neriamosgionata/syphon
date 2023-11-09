import Finance from "@ioc:Providers/Finance";
import Config from "@ioc:Adonis/Core/Config";
import TickerChart from "App/Models/TickerChart";
import {ChartResultArray, ChartResultArrayQuote} from "yahoo-finance2/dist/esm/src/modules/chart";
import {BaseJobParameters, loadData, runJob} from "App/Services/Jobs/JobHelpers";
import {ChartInterval} from "App/Services/Finance/Finance";
import {toLuxon} from "@adonisjs/validator/build/src/Validations/date/helpers/toLuxon";

const createChartEntry = async (
  ticker: string,
  entry: ChartResultArrayQuote,
  interval: ChartInterval
) => {
  const defaultAppDateTimeFormat = Config.get("app.date_formats.default");

  await TickerChart
    .create({
      ticker: ticker,
      date: toLuxon(entry.date, defaultAppDateTimeFormat),
      volume: entry.volume,
      open: entry.open,
      low: entry.low,
      close: entry.close,
      adjclose: entry.adjclose,
      interval: interval
    });
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

  const lastDate = lastTicker.date;
  const lastDateIndex = elements.findIndex((el) => el.date < lastDate.toJSDate());

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
  const parameters = loadData<ImportChartDataJobParameters>(["ticker", "fromDate", "interval"]);

  if (!Array.isArray(parameters.ticker)) {
    parameters.ticker = [parameters.ticker];
  }

  for (const ticker of parameters.ticker) {
    await importElementsFromFinance(
      ticker,
      await Finance.getChartViaTicker(ticker, parameters.fromDate),
      parameters.interval
    );
  }
};

export interface ImportChartDataJobParameters extends BaseJobParameters {
  ticker: string | string[];
  fromDate: string | number;
  interval: ChartInterval;
}

export default runJob(handler);
