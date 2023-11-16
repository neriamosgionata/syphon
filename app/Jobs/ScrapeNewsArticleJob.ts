import {BaseJobParameters, loadData, messageToParent, configureJob} from "App/Services/Jobs/JobHelpers";
import Newsletter from "@ioc:Providers/Newsletter";

const scraperNewsArticle = async (articleUrl: string) => {
  return await Newsletter.getArticle(articleUrl);
}

const handler = async () => {
  const parameters = loadData<ScrapeNewsArticleJobParameters>(["articleUrl"]);

  const res = await scraperNewsArticle(parameters.articleUrl);

  messageToParent(res);
};

export interface ScrapeNewsArticleJobParameters extends BaseJobParameters {
  articleUrl: string;
}

export default configureJob(handler);
