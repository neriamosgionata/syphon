import {loadJobParameters, configureJob} from "App/Services/Jobs/JobHelpers";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import Finance from "@ioc:Providers/Finance";
import Profile from "App/Models/Profile";
import Logger from "@ioc:Providers/Logger";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";

const updateProfile = async (ticker: string, profile: Quote) => {
  await Profile
    .query()
    .where("ticker", ticker)
    .update(Profile.createObject(ticker, profile))
    .exec();
}

const importQuoteFromFinance = async (ticker: string) => {
  const quote = await Finance.getQuoteViaTicker(ticker);
  await updateProfile(ticker, quote);
}

const handler = async () => {
  const parameters = loadJobParameters<ImportProfileDataJobParameters>();

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
