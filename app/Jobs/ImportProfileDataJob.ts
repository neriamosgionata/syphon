import {BaseJobParameters, loadData, configureJob} from "App/Services/Jobs/JobHelpers";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import Finance from "@ioc:Providers/Finance";
import Profile from "App/Models/Profile";
import Config from "@ioc:Adonis/Core/Config";
import {toLuxon} from "@adonisjs/validator/build/src/Validations/date/helpers/toLuxon";
import {ProfileQuoteTypeEnum} from "App/Enums/ProfileQuoteTypeEnum";
import {ProfileMarketStateEnum} from "App/Enums/ProfileMarketStateEnum";
import Logger from "@ioc:Providers/Logger";

const createObject = (ticker: string, profile: Quote) => {
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

const createProfile = async (ticker: string, profile: Quote) => {
  await Profile
    .create(createObject(ticker, profile))
}

const updateProfile = async (ticker: string, profile: Quote) => {
  await Profile
    .query()
    .where("ticker", ticker)
    .update(createObject(ticker, profile))
    .exec();
}

const importQuoteFromFinance = async (ticker: string) => {
  const lastIndex = await Profile
    .query()
    .where("ticker", ticker)
    .orderBy("index_date", "desc")
    .first();

  if (!lastIndex) {
    const quote = await Finance.getQuoteViaTicker(ticker);
    await createProfile(ticker, quote);
    return;
  }

  const lastIndexDate = lastIndex.indexDate.toJSDate().getTime();
  const nowMinus15Days = (new Date()).getTime() - (15 * 24 * 60 * 60 * 1000);

  if (lastIndexDate > nowMinus15Days) {
    return;
  }

  const quote = await Finance.getQuoteViaTicker(ticker);
  await updateProfile(ticker, quote);
}

const handler = async () => {
  const parameters = loadData<ImportProfileDataJobParameters>(["ticker"]);

  if (!Array.isArray(parameters.ticker)) {
    parameters.ticker = [parameters.ticker];
  }

  for (const ticker of parameters.ticker) {
    try {
      await importQuoteFromFinance(ticker);
    } catch (e) {
      Logger.error(`Error importing profile data for ${ticker}: ${e.message}`);
    }
  }
};

export interface ImportProfileDataJobParameters extends BaseJobParameters {
  ticker: string | string[];
}

export default configureJob(handler);
