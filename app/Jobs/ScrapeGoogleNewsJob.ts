import {BaseJobParameters, loadData, messageToParent, configureJob} from "App/Services/Jobs/JobHelpers";
import Newsletter from "@ioc:Providers/Newsletter";

const scraperGoogleNews = async (searchQuery: string) => {
  return await Newsletter.getGoogleNewsArticlesFor(searchQuery);
}

const handler = async () => {
  const parameters = loadData<ScrapeGoogleNewsJobParameters>(["searchQuery"]);

  const res = await scraperGoogleNews(parameters.searchQuery);

  messageToParent(res);
};

export interface ScrapeGoogleNewsJobParameters extends BaseJobParameters {
  searchQuery: string;
}

export default configureJob(handler);
