import {configureJob, loadJobParameters, payloadToParent} from "App/Services/Jobs/JobHelpers";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Newsletter from "@ioc:Providers/Newsletter";
import Helper from "@ioc:Providers/Helper";
import Console from "@ioc:Providers/Console";

const handler = async () => {
  const {articleUrl} = loadJobParameters<ScrapeNewsArticleJobParameters>();

  const res = await Newsletter.getArticle(articleUrl);

  if (Helper.isNotFalsy(res.results.content)) {
    payloadToParent(res.results);
  } else {
    Console.error("No content found for article", articleUrl);
  }
};

export interface ScrapeNewsArticleJobParameters extends BaseJobParameters {
  articleUrl: string;
}

export default configureJob(handler);
