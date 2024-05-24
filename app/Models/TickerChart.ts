import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {ChartInterval} from "App/Services/Finance/Finance";
import * as dfd from "danfojs-node";
import Console from "@ioc:Providers/Console";
import Profile from "App/Models/Profile";
import {ChartResultArrayQuote} from "yahoo-finance2/dist/esm/src/modules/chart";

export default class TickerChart extends BaseModel {
  public static table = "ticker_charts";

  @column({isPrimary: true})
  public id: number;

  @column.dateTime({autoCreate: true})
  public createdAt: DateTime;

  @column.dateTime({autoCreate: true, autoUpdate: true})
  public updatedAt: DateTime;

  @column()
  public ticker: string;

  // @ts-ignore
  @column.dateTime()
  public date: DateTime | null | string;

  @column()
  public volume: number | null;

  @column()
  public open: number | null;

  @column()
  public low: number | null;

  @column()
  public close: number | null;

  @column()
  public adjclose: number | null;

  @column()
  public high: number | null;

  @column()
  public interval: ChartInterval;

  static async getTickerChart(
    fromDate?: string,
    toDate?: string,
    ticker?: string | string[],
    interval?: string,
    sortBy?: string,
    sortDirection?: "asc" | "desc",
  ): Promise<TickerChart[]> {
    const query = TickerChart.query();

    if (ticker) {
      if (Array.isArray(ticker)) {
        query.whereIn("ticker", ticker);
      } else {
        query.where("ticker", ticker);
      }
    }

    if (interval) {
      query.where("interval", interval);
    }

    if (fromDate) {
      query.where("date", ">=", fromDate);
    }

    if (toDate) {
      query.where("date", "<=", toDate);
    }

    if (sortBy) {
      query.orderBy(sortBy, sortDirection || "desc");
    }

    return query.exec();
  }

  static async TickerChartTable(
    fromDate?: string,
    toDate?: string,
    ticker?: string | string[],
    interval?: string,
  ): Promise<number[][]> {
    const allProfiles = await Profile.allProfilesToANNData(ticker);

    Console.log("Mapping final data...");

    const finalData = [] as number[][];

    const tickerChartsData = await TickerChart.getTickerChart(fromDate, toDate, ticker, interval, "date", "asc");

    for (const profile of allProfiles) {
      const tickerCharts = tickerChartsData.filter((row) => row.ticker === profile.ticker)
        .map((row) => ([row.high || 0]))
        .reduce((acc, row) => ([...acc, row[0]]), []);

      finalData.push([
        ...profile.data,
        ...tickerCharts,
      ]);
    }

    let smallest = 999999999999;

    for (const row of finalData) {
      if (row.length < smallest) {
        smallest = row.length;
      }
    }

    for (const row in finalData) {
      finalData[row] = finalData[row].slice(0, smallest);
    }

    Console.log("Mapping final data... Done");

    return finalData;
  }

  static async TickerChartToANNData(
    fromDate?: string,
    toDate?: string,
    ticker?: string | string[],
    interval?: string,
  ) {
    const table = await this.TickerChartTable(fromDate, toDate, ticker, interval);

    return new dfd.DataFrame(table);
  }

  static createObjectFromYahoo(ticker: string, interval: ChartInterval, entry: ChartResultArrayQuote): Partial<TickerChart> {
    return {
      ticker: ticker,
      date: DateTime.fromISO(entry.date.toISOString()).toSQL({includeOffset: false}),
      high: entry.high,
      volume: entry.volume,
      open: entry.open,
      low: entry.low,
      close: entry.close,
      adjclose: entry.adjclose,
      interval: interval
    };
  }
}
