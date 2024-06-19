import {configureJob, loadJobParameters} from "App/Services/Jobs/JobHelpers";
import ProgressBar from "@ioc:Providers/ProgressBar";
import Helper from "@ioc:Providers/Helper";
import Console from "@ioc:Providers/Console";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Newsletter from "@ioc:Providers/Newsletter";
import Jobs from "@ioc:Providers/Jobs";
import {ScrapeNewsArticleJobParameters} from "App/Jobs/ScrapeNewsArticleJob";
import StringCleaner from "@ioc:Providers/StringCleaner";
import Profile from "App/Models/Profile";

const handler = async () => {
  let data = loadJobParameters<AnalyzeNewsletterForTickerJobParameters>();

  const profile = await Profile.query().where('ticker', data.ticker).firstOrFail();

  //RUN GOOGLE NEWS SCRAPING

  const res = await Newsletter.getGoogleNewsArticlesByTickerProfile(profile);

  if (res.errors.length > 0) {
    Console.error(res.errors);
    return;
  }

  const articlesUrl = res.results.articlesUrl;

  const articleData: Map<string, string> = new Map();

  const index = await ProgressBar.newBar(articlesUrl.length, "Scraping articles");

  do {
    const running = articlesUrl.splice(0, 8)
      .map((articleUrl) => Jobs.dispatchSync<ScrapeNewsArticleJobParameters>(
          "ScrapeNewsArticleJob",
          {
            articleUrl
          },
          [],
          (message) => {
            articleData.set(
              articleUrl,
              message.payload.content,
            );
          },
        )
      );

    await Promise.all(running);

    await ProgressBar.increment(index, running.length);
  } while (articlesUrl.length > 0);

  //RUN ARTICLE SCRAPING

  await ProgressBar.finishAll();

  try {
    let index = await ProgressBar.newBar(articleData.size, "Cleaning articles");

    const cleanedArticles: string[] = [];

    for (const article of articleData.entries()) {
      cleanedArticles.push(
        StringCleaner
          .setString(article[1])
          .removeHtmlEntities()
          .removeDashes()
          .removeEscapeCharacters()
          .stripEmails()
          .stripPhoneNumbers()
          .toString()
      );

      await ProgressBar.increment(index, 1);
    }

    await ProgressBar.finishAll();

    Console.log("Articles cleaned.");

    const loadedSentiments: number[] = [];

    index = await ProgressBar.newBar(cleanedArticles.length, "Analyzing sentiments");

    for (const articleToAnalyze of cleanedArticles) {
      loadedSentiments.push(
        await Helper.analyzeUnknownTextSentiment(articleToAnalyze)
      );

      await ProgressBar.increment(index, 1);
    }

    await ProgressBar.finishAll();

    Console.log("Sentiments calculated: ");

    Console.log(loadedSentiments);

  } catch (e) {
    Console.error(e);
  }

};

export interface AnalyzeNewsletterForTickerJobParameters extends BaseJobParameters {
  ticker: string;
}

export default configureJob(handler);
