import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {ProfileQuoteTypeEnum} from "App/Enums/ProfileQuoteTypeEnum";
import {ProfileMarketStateEnum} from "App/Enums/ProfileMarketStateEnum";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import Config from "@ioc:Adonis/Core/Config";
import {toLuxon} from "@adonisjs/validator/build/src/Validations/date/helpers/toLuxon";

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

  @column({columnName: "average_daily_volume_3_month"})
  averageDailyVolume3Month: number | null;

  @column({columnName: "average_daily_volume_10_day"})
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

  static createObject(ticker: string, profile: Quote) {
    const currentDate = new Date();
    const defaultAppDateTimeFormat = Config.get("app.date_formats.default");

    return {
      ticker: ticker,
      language: profile.language,
      region: profile.region,
      quoteType: profile.quoteType as ProfileQuoteTypeEnum,
      quoteSourceName: profile.quoteSourceName,
      currency: profile.currency,
      marketState: profile.marketState as ProfileMarketStateEnum,
      tradeable: profile.tradeable,
      cryptoTradeable: profile.cryptoTradeable,
      exchange: profile.exchange,
      shortName: profile.shortName,
      longName: profile.longName,
      exchangeTimezoneName: profile.exchangeTimezoneName,
      exchangeTimezoneShortName: profile.exchangeTimezoneShortName,
      market: profile.market,
      dividendDate: toLuxon(profile.dividendDate, defaultAppDateTimeFormat),
      trailingAnnualDividendRate: profile.trailingAnnualDividendRate,
      trailingPE: profile.trailingPE,
      trailingAnnualDividendYield: profile.trailingAnnualDividendYield,
      epsTrailingTwelveMonths: profile.epsTrailingTwelveMonths,
      epsForward: profile.epsForward,
      epsCurrentYear: profile.epsCurrentYear,
      priceEpsCurrentYear: profile.priceEpsCurrentYear,
      sharesOutstanding: profile.sharesOutstanding,
      bookValue: profile.bookValue,
      marketCap: profile.marketCap,
      financialCurrency: profile.financialCurrency,
      averageDailyVolume3Month: profile.averageDailyVolume3Month,
      averageDailyVolume10Day: profile.averageDailyVolume10Day,
      displayName: profile.displayName,
      ytdReturn: profile.ytdReturn,
      prevName: profile.prevName,
      averageAnalystRating: profile.averageAnalystRating,
      openInterest: profile.openInterest,
      indexDate: toLuxon(currentDate, defaultAppDateTimeFormat),
    }
  }

}
