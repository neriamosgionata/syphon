import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {ProfileQuoteTypeEnum} from "App/Enums/ProfileQuoteTypeEnum";
import {ProfileMarketStateEnum} from "App/Enums/ProfileMarketStateEnum";

export default class Profile extends BaseModel {
  @column({isPrimary: true})
  public id: number;

  @column()
  language: string;

  @column()
  region: string;

  @column()
  quoteType: ProfileQuoteTypeEnum;

  @column()
  quoteSourceName: string | null;

  @column()
  currency: string | null;

  @column()
  marketState: ProfileMarketStateEnum;

  @column()
  tradeable: boolean;

  @column()
  cryptoTradeable: boolean | null;

  @column()
  exchange: string;

  @column()
  shortName: string | null;

  @column()
  longName: string | null;

  @column()
  exchangeTimezoneName: string;

  @column()
  exchangeTimezoneShortName: string;

  @column()
  market: string;

  @column.dateTime()
  dividendDate: DateTime;

  @column()
  trailingAnnualDividendRate: number | null;

  @column()
  trailingPE: number | null;

  @column()
  trailingAnnualDividendYield: number | null;

  @column()
  epsTrailingTwelveMonths: number | null;

  @column()
  epsForward: number | null;

  @column()
  epsCurrentYear: number | null;

  @column()
  priceEpsCurrentYear: number | null;

  @column()
  sharesOutstanding: number | null;

  @column()
  bookValue: number | null;

  @column()
  marketCap: number | null;

  @column()
  financialCurrency: string | null;

  @column()
  averageDailyVolume3Month: number | null;

  @column()
  averageDailyVolume10Day: number | null;

  @column()
  displayName: string | null;

  @column()
  ticker: string;

  @column()
  ytdReturn: number | null;

  @column()
  prevName: string | null;

  @column()
  averageAnalystRating: string | null;

  @column()
  openInterest: number | null;

  @column.dateTime()
  indexDate: DateTime;

  @column.dateTime({autoCreate: true})
  public createdAt: DateTime;

  @column.dateTime({autoCreate: true, autoUpdate: true})
  public updatedAt: DateTime;
}
