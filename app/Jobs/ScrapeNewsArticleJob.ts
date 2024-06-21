import {configureJob, loadJobParameters, payloadToParent} from "App/Services/Jobs/JobHelpers";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Newsletter from "@ioc:Providers/Newsletter";

const handler = async () => {
  const {articleUrl} = loadJobParameters<ScrapeNewsArticleJobParameters>();

  const res = await Newsletter.getArticle(articleUrl);

  if (res.results.content) {
    payloadToParent(res.results);
    return;
  }
};

export interface ScrapeNewsArticleJobParameters extends BaseJobParameters {
  articleUrl: string;
}

export default configureJob(handler);
