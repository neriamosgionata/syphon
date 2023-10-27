import Scraper from "@ioc:Providers/Scraper";
import {HandlerFunction, RunReturn} from "App/Services/Scraper/BaseScraper";

export interface NewsletterContract {
  getGoogleNewsArticlesFor(searchQuery: string): Promise<RunReturn<{ articlesUrl: string[] }>>;
}

export default class Newsletter implements NewsletterContract {
  private goToGoogleNews(): HandlerFunction<void> {
    return () => Scraper.goto("https://news.google.com/", 10000);
  }

  private searchFor(searchQuery: string): HandlerFunction<void> {
    return () => Scraper.typeIn("input:not([aria-hidden=\"true\"])", searchQuery, {delay: 33});
  }

  private getArticlesUrl(): HandlerFunction<{ articlesUrl: string[] }> {
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

  async getGoogleNewsArticlesFor(searchQuery: string) {
    const scraper = Scraper
      .setHandlers([
        this.goToGoogleNews(),
        this.searchFor(searchQuery),
        this.getArticlesUrl(),
      ]);

    return await scraper.run<{
      articlesUrl: string[]
    }>();
  }
}
