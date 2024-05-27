import {loadJobParameters, payloadToParent, configureJob} from "App/Services/Jobs/JobHelpers";
import Newsletter from "@ioc:Providers/Newsletter";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Console from "@ioc:Providers/Console";

const scraperGoogleNews = async (searchQuery: string) => {
  return await Newsletter.getGoogleNewsArticlesFor(searchQuery);
}

const handler = async () => {
  const parameters = loadJobParameters<ScrapeGoogleNewsJobParameters>();

  Console.log(`Scraping google news for ${parameters.searchQuery}`);

  const res = await scraperGoogleNews(parameters.searchQuery);

  payloadToParent(res);
};

export interface ScrapeGoogleNewsJobParameters extends BaseJobParameters {
  searchQuery: string;
}

export default configureJob(handler);
