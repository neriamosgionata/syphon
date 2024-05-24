import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {ProfileQuoteTypeEnum} from "App/Enums/ProfileQuoteTypeEnum";
import {ProfileMarketStateEnum} from "App/Enums/ProfileMarketStateEnum";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import * as dfd from "danfojs-node";
import Console from "@ioc:Providers/Console";
import Helper from "@ioc:Providers/Helper";

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

  // @ts-ignore
  @column.dateTime()
  dividendDate: DateTime | null | string;

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

  // @ts-ignore
  @column.dateTime()
  indexDate: DateTime | string;

  @column.dateTime({autoCreate: true})
  public createdAt: DateTime;

  @column.dateTime({autoCreate: true, autoUpdate: true})
  public updatedAt: DateTime;

  static createObjectFromYahoo(ticker: string, profile: Quote): Partial<Profile> {
    return {
      ticker: ticker,
      language: profile.language,
      region: profile.region,
      quoteType: profile.quoteType as ProfileQuoteTypeEnum,
      quoteSourceName: profile.quoteSourceName ? Helper.sanitizeWords(profile.quoteSourceName) : null,
      currency: profile.currency || null,
      marketState: profile.marketState as ProfileMarketStateEnum,
      tradeable: profile.tradeable,
      cryptoTradeable: profile.cryptoTradeable || null,
      exchange: profile.exchange,
      shortName: profile.shortName ? Helper.sanitizeWords(profile.shortName) : null,
      longName: profile.longName ? Helper.sanitizeWords(profile.longName) : null,
      exchangeTimezoneName: profile.exchangeTimezoneName,
      exchangeTimezoneShortName: profile.exchangeTimezoneShortName,
      market: profile.market,
      trailingAnnualDividendRate: profile.trailingAnnualDividendRate || null,
      trailingPE: profile.trailingPE || null,
      trailingAnnualDividendYield: profile.trailingAnnualDividendYield || null,
      epsTrailingTwelveMonths: profile.epsTrailingTwelveMonths || null,
      epsForward: profile.epsForward || null,
      epsCurrentYear: profile.epsCurrentYear || null,
      priceEpsCurrentYear: profile.priceEpsCurrentYear || null,
      sharesOutstanding: profile.sharesOutstanding || null,
      bookValue: profile.bookValue || null,
      marketCap: profile.marketCap || null,
      financialCurrency: profile.financialCurrency || null,
      averageDailyVolume3Month: profile.averageDailyVolume3Month || null,
      averageDailyVolume10Day: profile.averageDailyVolume10Day || null,
      displayName: profile.displayName ? Helper.sanitizeWords(profile.displayName) : null,
      ytdReturn: profile.ytdReturn || null,
      prevName: profile.prevName ? Helper.sanitizeWords(profile.prevName) : null,
      averageAnalystRating: profile.averageAnalystRating || null,
      openInterest: profile.openInterest || null,
      dividendDate: profile.dividendDate ? DateTime.fromISO(profile.dividendDate.toISOString()).toSQL({includeOffset: false}) : null,
      indexDate: DateTime.fromISO(new Date().toISOString(), {}).toSQL({includeOffset: false}) as string,
    };
  }

  toANNData(): (string | number)[] {
    return [
      this.ticker,
      (this.language || "en-US").toString(),
      (this.region || "US").toString(),
      this.quoteType as ProfileQuoteTypeEnum,
      (this.currency || "USD").toString(),
      this.marketState as ProfileMarketStateEnum,
      this.tradeable ? 1 : 0,
      this.cryptoTradeable ? 1 : 0,
      this.exchangeTimezoneName || "America/New_York",
      this.exchangeTimezoneShortName || "EDT",
      this.market || "us_market",
      this.trailingAnnualDividendRate || 0,
      this.trailingPE || 0,
      this.trailingAnnualDividendYield || 0,
      this.epsTrailingTwelveMonths || 0,
      this.epsForward || 0,
      this.epsCurrentYear || 0,
      this.priceEpsCurrentYear || 0,
      this.sharesOutstanding || 0,
      this.bookValue || 0,
      this.marketCap || 0,
      (this.financialCurrency || "USD").toString(),
      this.averageDailyVolume3Month || 0,
      this.averageDailyVolume10Day || 0,
      this.ytdReturn || 0,
      (this.averageAnalystRating || "N/A").toString(),
      this.openInterest || 0,
    ];
  }

  static async getTickers(ticker?: string | string[]) {
    if (ticker) {
      ticker = Array.isArray(ticker) ? ticker : [ticker];
    } else {
      ticker = undefined;
    }

    return ticker ? await Profile.query().whereIn("ticker", ticker).exec() : await Profile.all();
  }

  static async allProfilesToANNData(ticker?: string | string[]): Promise<{ ticker: string; data: number[] }[]> {
    const profiles = await this.getTickers(ticker);

    const mappedProfiles = profiles.map((profile) => profile.toANNData());

    Console.log("Mapping profiles...");

    const indexesOfNonNumericColumn = mappedProfiles[0]
      .reduce((acc, value, index) => {
        if (typeof value !== "number") {
          acc.push(index);
        }

        return acc;
      }, [] as number[]);

    const finalData: {
      ticker: string,
      data: number[],
    } [] = [];

    const tickers = mappedProfiles.reduce((acc, profile) => {
      return [...acc, profile[0]];
    }, []) as string[];

    for (const index of indexesOfNonNumericColumn) {
      const fitting_series = mappedProfiles.reduce((acc, row) => ([...acc, row[index]]), []);

      const encoder = new dfd.LabelEncoder();
      encoder.fit(fitting_series);

      for (const mappedProfileIndex in mappedProfiles) {
        mappedProfiles[mappedProfileIndex][index] = encoder.transform([mappedProfiles[mappedProfileIndex][index]])[0];
      }
    }

    for (const mappedProfileIndex in mappedProfiles) {
      finalData.push({
        ticker: tickers[mappedProfileIndex],
        data: mappedProfiles[mappedProfileIndex] as number[],
      });
    }

    Console.log("Mapped profiles: " + mappedProfiles.length + " profiles...");

    return finalData;
  }
}
