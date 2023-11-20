import Scraper from "@ioc:Providers/Scraper";
import {ScraperHandlerFunction, ScraperRunReturn} from "App/Services/Scraper/BaseScraper";

export interface NewsletterContract {
  getGoogleNewsArticlesFor(searchQuery: string): Promise<ScraperRunReturn<{ articlesUrl: string[] }>>;

  getArticles(articleUrls: string[]): Promise<Map<string, ScraperRunReturn<{ title?: string; content?: string }>>>;

  getArticle(articleUrl: string): Promise<ScraperRunReturn<{ title?: string, content?: string }>>;
}

export default class Newsletter implements NewsletterContract {

  private getArticlesUrls(searchQuery: string): ScraperHandlerFunction<{ articlesUrl: string[] }> {
    return Scraper.evaluate((sQ: string) => {
      const container = document.querySelector('div[data-n-ca-it^="' + sQ + '"]')
      if (!container) {
        return {articlesUrl: []};
      }
      const articles = container.querySelectorAll("article");
      const articlesUrl: string[] = [];
      for (const article of articles) {
        const url = article.querySelector("a")?.getAttribute("href");
        if (url) {
          articlesUrl.push("https://news.google.com/" + url.replace("./", ""));
        }
      }
      return {articlesUrl};
    }, searchQuery);
  }

  private getArticleContent(): ScraperHandlerFunction<{ title?: string, content?: string }> {
    return Scraper.evaluate(() => {
      const title = (document.querySelector("h1") || document.querySelector("h2"))?.innerText;

      const articleBodySelectors = [
        '*[class*="articleBody" i]',
        '*[class*="article-body" i]',
        '*[class*="description" i]',
        'article > p',
        'article > div',
      ]

      let content = "";

      for (const articleBodySelector of articleBodySelectors) {
        const allElements = [
          ...document.querySelectorAll(articleBodySelector)
        ] as HTMLElement[];

        if (allElements.length === 0) {
          continue;
        }

        const tmpContent = allElements.map(el => el.innerText).join("\n");

        if (tmpContent) {
          content = tmpContent;
          break;
        }
      }

      return {title, content};
    });
  }

  async getGoogleNewsArticlesFor(searchQuery: string): Promise<ScraperRunReturn<{ articlesUrl: string[] }>> {
    const scraper = Scraper
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto("https://news.google.com/"),
        Scraper.waitRandom(),
        Scraper.removeGPDR(),
        Scraper.waitRandom(),
        ...Scraper.searchAndEnter("input:not([aria-hidden=\"true\"])", searchQuery),
        Scraper.waitRandom(),
        Scraper.autoScroll(50),
        Scraper.waitRandom(),
        this.getArticlesUrls(searchQuery),
      ]);

    return await scraper.run<{
      articlesUrl: string[]
    }>();
  }

  async getArticles(articleUrls: string[]): Promise<Map<string, ScraperRunReturn<{
    title?: string;
    content?: string
  }>>> {
    const map = new Map<string, ScraperRunReturn<{ title?: string; content?: string }>>();

    for (let articleUrl of articleUrls) {
      const scraper = Scraper
        .setScraperStatusName("newsletter-get-articles")
        .setWithAdblockerPlugin(true)
        .setWithStealthPlugin(true)
        .setHandlers([
          Scraper.goto(articleUrl),
          Scraper.waitRandom(),
          Scraper.removeGPDR(),
          Scraper.waitRandom(),
          this.getArticleContent(),
        ]);

      const res = await scraper.run<{
        title?: string,
        content?: string
      }>();

      map.set(articleUrl, res);
    }

    return map;
  }

  async getArticle(articleUrl: string): Promise<ScraperRunReturn<{ title?: string, content?: string }>> {
    const scraper = Scraper
      .setScraperStatusName("newsletter-get-single-article")
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto(articleUrl),
        Scraper.waitRandom(),
        Scraper.removeGPDR(),
        Scraper.waitRandom(),
        this.getArticleContent(),
      ]);

    return await scraper.run<{
      title?: string,
      content?: string
    }>();
  }
}
