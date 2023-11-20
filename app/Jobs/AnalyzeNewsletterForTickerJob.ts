import {BaseJobParameters, configureJob, loadData} from "App/Services/Jobs/JobHelpers";
import {ScrapeGoogleNewsJobParameters} from "App/Jobs/ScrapeGoogleNewsJob";
import {ScraperRunReturn} from "App/Services/Scraper/BaseScraper";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {ScrapeNewsArticleJobParameters} from "App/Jobs/ScrapeNewsArticleJob";
import Helper from "@ioc:Providers/Helper";
import Jobs from "@ioc:Providers/Jobs";
import {PorterStemmer} from "natural";
import Console from "@ioc:Providers/Console";

const handler = async () => {
  let data = loadData<AnalyzeNewsletterForTickerJobParameters>(["ticker"]);
  let articleUrls: string[] = [];

  //RUN GOOGLE NEWS SCRAPING

  await Jobs.runWithoutDispatch<ScrapeGoogleNewsJobParameters>(
    "ScrapeGoogleNewsJob",
    {
      searchQuery: data.ticker,
    },
    [],
    (jobMessage) => {
      const payload = jobMessage.payload as ScraperRunReturn<{ articlesUrl: string[] }>;
      articleUrls.push(...payload.results.articlesUrl);
    }
  );

  //RUN ARTICLE SCRAPING

  let articleData: Map<string, { title?: string; content?: string }> = new Map();
  let chunk: (() => Promise<{ id: string; tags: string[]; error?: Error | undefined; }>)[] = [];
  let index = ProgressBar.newBar(articleUrls.length, "Scraping articles");

  do {
    let articles: string[] = articleUrls.splice(0, 4);

    chunk = articles.map((articleUrl) =>
      () => Jobs.runWithoutDispatch<ScrapeNewsArticleJobParameters>(
        "ScrapeNewsArticleJob",
        {
          articleUrl,
        },
        [],
        (jobMessage) => {
          if (jobMessage.payload.results.title && jobMessage.payload.results.content) {
            articleData.set(
              articleUrl,
              jobMessage.payload.results as { title?: string; content?: string },
            );
          }
        }
      )
    );

    await Promise.all(chunk.map((job) => job()));

    ProgressBar.increment(index, articles.length);

  } while (articleUrls.length > 0);

  ProgressBar.finish(index);

  let toLoad: string[][] = [];

  index = ProgressBar.newBar(articleData.size, "Cleaning articles");

  for (const article of articleData.entries()) {
    toLoad.push(
      Helper.removeStopwords(
        Helper.cleanText(article[1]?.content || ""),
      )
    );

    ProgressBar.increment(index);
  }

  ProgressBar.finish(index);

  let loadedSentiments = toLoad.map((splitted) => Helper.analyzeSentiment(splitted, "Italian", PorterStemmer, "pattern"));

  Console.log(loadedSentiments);
};

export interface AnalyzeNewsletterForTickerJobParameters extends BaseJobParameters {
  ticker: string;
}

export default configureJob(handler);
