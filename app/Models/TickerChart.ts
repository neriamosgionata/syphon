import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {ChartInterval} from "App/Services/Finance/Finance";
import * as dfd from "danfojs-node";
import Console from "@ioc:Providers/Console";
import Profile from "App/Models/Profile";

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

  @column.dateTime()
  public date: DateTime;

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

  static async TickerChartToANNData(
    fromDate?: string,
    toDate?: string,
    ticker?: string | string[],
    interval?: string,
  ) {
    const data = await TickerChart.getTickerChart(fromDate, toDate, ticker, interval, "date", "asc");

    Console.log("Retrieved " + data.length + " ticker chart data...");

    const allProfiles = await Profile.allProfilesToANNData();

    Console.log("Retrieved " + allProfiles.length + " mapped profiles...");

    const mappedData = data
      .filter((row) => allProfiles.find((profile) => profile.ticker === row.ticker))
      .map((row) => ([
        row.ticker,
        row.high || 0,
        row.close || 0,
        row.low || 0,
        row.open || 0,
        row.adjclose || 0,
        row.volume || 0,
        row.date.toJSDate().getTime(),
      ]))
      // @ts-ignore
      .sort((a, b) => (a[7] - b[7])) as [string, number, number, number, number, number, number, number][];

    Console.log("Mapping final data...");

    let finalData = allProfiles
      .map((profile) => ([
        ...profile.data,
        ...mappedData
          .filter((row) => row[0] === profile.ticker)
          .map((row) => row[1]),
      ]));

    const longestArrayLength = finalData
      .reduce((currentLength, currentArray) =>
        currentArray.length > currentLength ? currentArray.length : currentLength, 0);

    for (const i in finalData) {
      if (finalData[i].length < longestArrayLength) {
        const missing_length = longestArrayLength - finalData[i].length;
        finalData[i] = [
          ...finalData[i].splice(0, allProfiles[0].data.length),
          ...Array(missing_length).fill(0),
          ...finalData[i]
        ];
      }
    }

    finalData = finalData.filter((row) => row.length === longestArrayLength);

    Console.log("Mapping final data... Done");

    return new dfd.DataFrame(finalData);
  }
}
