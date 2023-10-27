import Scraper from "@ioc:Providers/Scraper";
import {HandlerFunction, RunReturn} from "App/Services/Scraper/BaseScraper";

export interface NewsletterContract {
  getGoogleNewsArticlesFor(searchQuery: string): Promise<RunReturn<{ articlesUrl: string[] }>>;

  getArticles(articleUrls: string[]): Promise<Map<string, { title?: string, content?: string }>>;
}

export default class Newsletter implements NewsletterContract {
  private goToGoogleNews(): HandlerFunction<void> {
    return () => Scraper.goto("https://news.google.com/", 10000);
  }

  private getArticlesUrls(): HandlerFunction<{ articlesUrl: string[] }> {
    return () => Scraper.evaluate(() => {
      const articles = document.querySelectorAll("article");
      const articlesUrl: string[] = [];
      for (const article of articles) {
        const url = article.querySelector("a")?.getAttribute("href");
        if (url) {
          articlesUrl.push(url);
        }
      }
      return {articlesUrl};
    });
  }

  private goToArticleUrl(articleUrl: string): HandlerFunction<void> {
    return () => Scraper.goto(articleUrl, 10000);
  }

  private getArticleContent(): HandlerFunction<{ title?: string, content?: string }> {
    return () => Scraper.evaluate(() => {
      const title = (document.querySelector("h1") || document.querySelector("h2"))?.innerText;
      const content = document.querySelector("article")?.innerText;
      return {title, content};
    });
  }

  private searchForQuery(searchQuery: string): HandlerFunction<void> {
    return () => Scraper.searchAndEnter("input:not([aria-hidden=\"true\"])", searchQuery);
  }

  async getGoogleNewsArticlesFor(searchQuery: string): Promise<RunReturn<{ articlesUrl: string[] }>> {
    const scraper = Scraper
      .setHandlers([
        this.goToGoogleNews(),
        this.searchForQuery(searchQuery),
        this.getArticlesUrls(),
      ]);

    return await scraper.run<{
      articlesUrl: string[]
    }>();
  }

  async getArticles(articleUrls: string[]): Promise<Map<string, { title?: string; content?: string }>> {
    const map = new Map<string, { title?: string, content?: string }>();

    for (let articleUrl of articleUrls) {
      const scraper = Scraper
        .setHandlers([
          this.goToArticleUrl(articleUrl),
          this.getArticleContent(),
        ]);

      const res = await scraper.run<{
        title?: string,
        content?: string
      }>();

      map.set(articleUrl, res.results);
    }

    return map;
  }
}
