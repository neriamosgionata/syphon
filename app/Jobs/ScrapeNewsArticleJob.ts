import {configureJob, loadJobParameters, payloadToParent} from "App/Services/Jobs/JobHelpers";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Newsletter from "@ioc:Providers/Newsletter";
import Helper from "@ioc:Providers/Helper";

const handler = async () => {
  const {articleUrl} = loadJobParameters<ScrapeNewsArticleJobParameters>();

  const res = await Newsletter.getArticle(articleUrl);

  if (Helper.isNotFalsy(res.results.title) && Helper.isNotFalsy(res.results.content)) {
    payloadToParent({
      title: res.results.title,
      content: res.results.content
    });
  }
};

export interface ScrapeNewsArticleJobParameters extends BaseJobParameters {
  articleUrl: string;
}

export default configureJob(handler);
