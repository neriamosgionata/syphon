import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {ChartInterval} from "App/Services/Finance/Finance";
import moment from "moment/moment";

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
    ticker: string,
    interval: string,
    fromDate?: string,
    toDate?: string
  ): Promise<TickerChart[]> {

    fromDate = fromDate || moment().subtract(1, "year").format("YYYY-MM-DD");
    toDate = toDate || moment().format("YYYY-MM-DD");

    return TickerChart.query()
      .where("ticker", ticker)
      .where("interval", interval)
      .where("date", ">=", fromDate)
      .where("date", "<=", toDate)
      .exec();
  }
}
