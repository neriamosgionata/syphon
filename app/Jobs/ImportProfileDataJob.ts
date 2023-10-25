import {loadData, runJob} from "App/Services/Jobs/JobHelpers";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import Finance from "@ioc:Providers/Finance";
import Profile from "App/Models/Profile";
import Config from "@ioc:Adonis/Core/Config";
import {toLuxon} from "@adonisjs/validator/build/src/Validations/date/helpers/toLuxon";
import {ProfileQuoteTypeEnum} from "App/Enums/ProfileQuoteTypeEnum";
import {ProfileMarketStateEnum} from "App/Enums/ProfileMarketStateEnum";

const createProfile = async (ticker: string, profile: Quote) => {
  const currentDate = new Date();
  const defaultAppDateTimeFormat = Config.get("app.dateFormats.default");

  await Profile.create({
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
  });
}

const importQuoteFromFinance = async (ticker: string) => {
  const quote = await Finance.getQuoteViaTicker(ticker)
  await createProfile(ticker, quote);
}

const handler = async () => {
  const parameters = loadData(["ticker"]) as ImportProfileDataJobParameters;
  await importQuoteFromFinance(parameters.ticker);
};

export interface ImportProfileDataJobParameters {
  ticker: string;
}

export default runJob(handler);
