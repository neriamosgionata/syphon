import financeHandler from "yahoo-finance2";
import { Quote } from "yahoo-finance2/dist/esm/src/modules/quote";
import { ChartResultArray } from "yahoo-finance2/dist/esm/src/modules/chart";
import { QuoteSummaryResult } from "yahoo-finance2/dist/esm/src/modules/quoteSummary-iface";

export type ChartInterval =
  "1m"
  | "2m"
  | "5m"
  | "15m"
  | "30m"
  | "60m"
  | "90m"
  | "1h"
  | "1d"
  | "5d"
  | "1wk"
  | "1mo"
  | "3mo";

export type ChartOptions = {
  period1: Date | string | number;
  period2: Date | string | number;
  interval: ChartInterval;
}

export interface FinanceContract {
  getQuoteViaTicker(ticker: string): Promise<Quote>;

  getSummaryQuoteViaTicker(ticker: string): Promise<QuoteSummaryResult>;

  getChartViaTicker(ticker: string, fromDate: string | number, toDate?: string | number, interval?: ChartInterval): Promise<ChartResultArray>;
}

export default class Finance implements FinanceContract {

  public async getQuoteViaTicker(ticker: string): Promise<Quote> {
    return await financeHandler.quote(ticker);
  }

  public async getSummaryQuoteViaTicker(ticker: string): Promise<QuoteSummaryResult> {
    return await financeHandler.quoteSummary(ticker);
  }

  public async getChartViaTicker(ticker: string, fromDate: string | number, toDate?: string | number, interval: ChartInterval = "1d"): Promise<ChartResultArray> {
    const period1 = (new Date(fromDate)).toISOString();
    const period2 = toDate ? (new Date(toDate)).toISOString() : (new Date()).toISOString();

    const options: ChartOptions = {
      period1,
      period2,
      interval
    };

    return await financeHandler.chart(ticker, options);
  }

}
