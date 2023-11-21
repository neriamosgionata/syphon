import {loadJobParameters, messageToParent, configureJob} from "App/Services/Jobs/JobHelpers";
import Newsletter from "@ioc:Providers/Newsletter";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";

const scraperNewsArticle = async (articleUrl: string) => {
  return await Newsletter.getArticle(articleUrl);
}

const handler = async () => {
  const parameters = loadJobParameters<ScrapeNewsArticleJobParameters>();

  const res = await scraperNewsArticle(parameters.articleUrl);

  messageToParent(res);
};

export interface ScrapeNewsArticleJobParameters extends BaseJobParameters {
  articleUrl: string;
}

export default configureJob(handler);
