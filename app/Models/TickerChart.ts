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
    ticker?: string,
    interval?: string,
    sortBy?: string,
    sortDirection?: "asc" | "desc",
  ): Promise<TickerChart[]> {
    const query = TickerChart.query();

    if (ticker) {
      query.where("ticker", ticker);
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
    ticker?: string,
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
      ])) as [string, number, number, number, number, number, number][];

    Console.log("Mapping final data...");

    const finalData = allProfiles
      .map((profile) => {
        let allDataForProfile = mappedData
          .filter((row) => row[0] === profile.ticker);

        return [
          profile.data[0],
          ...profile.data.slice(1),
          ...allDataForProfile.map((row) => row[1]),
        ];
      });

    const longestArrayLength = finalData.reduce((currentLength, currentArray) => {
      if (currentArray.length > currentLength) {
        return currentArray.length;
      }

      return currentLength;
    }, 0);

    for (const array of finalData) {
      while (array.length < longestArrayLength) {
        array.push(0);
      }
    }

    Console.log("Mapping final data... Done");

    return new dfd.DataFrame(finalData);
  }
}
