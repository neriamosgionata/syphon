import {args, BaseCommand} from "@adonisjs/core/build/standalone";
import {JobContract} from "App/Services/Jobs/Jobs";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ScrapeGoogleNewsJobParameters} from "App/Jobs/ScrapeGoogleNewsJob";
import {ScraperRunReturn} from "App/Services/Scraper/BaseScraper";
import {ScrapeNewsArticleJobParameters} from "App/Jobs/ScrapeNewsArticleJob";

export default class TestNewsletter extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = "test:newsletter";

  /**
   * Command description is displayed in the "help" output
   */
  public static description = "";

  public static settings = {
    /**
     * Set the following value to true, if you want to load the application
     * before running the command. Don't forget to call `node ace generate:manifest`
     * afterwards.
     */
    loadApp: true,

    /**
     * Set the following value to true, if you want this command to keep running until
     * you manually decide to exit the process. Don't forget to call
     * `node ace generate:manifest` afterward.
     */
    stayAlive: false
  };

  @args.string({description: "Query", required: true})
  public query: string;

  public async run() {
    const Jobs: JobContract = this.application.container.use(AppContainerAliasesEnum.Jobs);

    const articleUrls: string[] = [];

    //RUN GOOGLE NEWS SCRAPING

    await Jobs.runWithoutDispatch<ScrapeGoogleNewsJobParameters>(
      "ScrapeGoogleNewsJob",
      {
        searchQuery: this.query,
      },
      [],
      (jobMessage) => {
        const payload = jobMessage.payload as ScraperRunReturn<{ articlesUrl: string[] }>;
        articleUrls.push(...payload.results.articlesUrl);
      }
    );

    //RUN ARTICLE SCRAPING

    let articleData: Map<string, ScraperRunReturn<{ title?: string; content?: string }>> = new Map();

    let chunk: (() => Promise<{ id: string; tags: string[]; error?: Error | undefined; }>)[] = [];
    let CHUNK_LENGTH = 4;

    for (const articleUrl of articleUrls) {
      chunk.push(
        () => Jobs.runWithoutDispatch<ScrapeNewsArticleJobParameters>(
          "ScrapeNewsArticleJob",
          {
            articleUrl,
          },
          [],
          (jobMessage) => {
            articleData.set(articleUrl, jobMessage.payload.results);
          }
        )
      );

      if (chunk.length === CHUNK_LENGTH) {
        await Promise.all(chunk.map(p => p()));
        chunk = [];
      }
    }

    if (chunk.length > 0) {
      await Promise.all(chunk.map(p => p()));
    }

    console.log(articleData);
  }
}
