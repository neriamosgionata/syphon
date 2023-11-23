import {configureJob, loadJobParameters} from "App/Services/Jobs/JobHelpers";
import {ScrapeGoogleNewsJobParameters} from "App/Jobs/ScrapeGoogleNewsJob";
import {ScraperRunReturn} from "App/Services/Scraper/BaseScraper";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {ScrapeNewsArticleJobParameters} from "App/Jobs/ScrapeNewsArticleJob";
import Helper from "@ioc:Providers/Helper";
import Jobs from "@ioc:Providers/Jobs";
import Console from "@ioc:Providers/Console";
import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";

const handler = async () => {
  let data = loadJobParameters<AnalyzeNewsletterForTickerJobParameters>();
  const articleUrls: string[] = [];

  //RUN GOOGLE NEWS SCRAPING

  await Jobs.waitUntilDone(
    await Jobs.dispatch<ScrapeGoogleNewsJobParameters>(
      "ScrapeGoogleNewsJob",
      {
        searchQuery: data.ticker,
      },
      [],
      (jobMessage) => {
        const payload = jobMessage.payload as ScraperRunReturn<{ articlesUrl: string[] }>;
        articleUrls.push(...payload.results.articlesUrl);
      }
    )
  );

  //RUN ARTICLE SCRAPING

  const articleData: Map<string, { title: string; content: string }> = new Map();
  let chunk: (() => Promise<JobMessageEnum>)[] = [];
  let index = ProgressBar.newBar(articleUrls.length, "Scraping articles");

  do {
    let articles: string[] = articleUrls.splice(0, 4);

    chunk = articles.map((articleUrl) =>
      async () => await Jobs.waitUntilDone(
        await Jobs.dispatch<ScrapeNewsArticleJobParameters>(
          "ScrapeNewsArticleJob",
          {
            articleUrl,
          },
          [],
          (jobMessage) => {
            if (Helper.isNotFalsy(jobMessage.payload.results.title) && Helper.isNotFalsy(jobMessage.payload.results.content)) {
              articleData.set(
                articleUrl,
                jobMessage.payload.results as { title: string; content: string },
              );
            }
          }
        )
      )
    );

    await Promise.all(chunk.map((job) => job()));

    ProgressBar.increment(index, articles.length);

  } while (articleUrls.length > 0);

  ProgressBar.finishAll();

  try {

    const cleanedArticles: string[][] = [];

    for (const article of articleData.entries()) {
      cleanedArticles.push(
        Helper.removeStopwords(
          Helper.cleanText(article[1].content)
        )
      );
    }

    Console.log("Articles cleaned.");

    const loadedSentiments: number[] = [];

    for (const articleToAnalyze of cleanedArticles) {
      loadedSentiments.push(
        await Helper.analyzeUnknownTextSentiment(articleToAnalyze)
      );
    }

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
