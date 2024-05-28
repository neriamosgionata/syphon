import Scraper from "@ioc:Providers/Scraper";
import {ScraperHandlerFunction, ScraperRunReturn} from "App/Services/Scraper/BaseScraper";

export interface NewsletterContract {
  getGoogleNewsArticlesBySearchQuery(searchQuery: string): Promise<ScraperRunReturn<{ articlesUrl: string[] }>>;

  getArticle(articleUrl: string): Promise<ScraperRunReturn<{ title?: string, content?: string }>>;
}

export default class Newsletter implements NewsletterContract {

  private getArticlesUrls(): ScraperHandlerFunction<{ articlesUrl: string[] }> {
    return Scraper.evaluate(() => {
      const articles = document.querySelectorAll("article");
      const articlesUrl: string[] = [];

      for (const article of articles) {
        const url = article.querySelector("a")?.getAttribute("href");
        if (url) {
          articlesUrl.push("https://news.google.com/" + url.replace("./", ""));
        }
      }

      return {articlesUrl};
    });
  }

  private getArticleContent(): ScraperHandlerFunction<{ title?: string, content?: string }> {
    return Scraper.evaluate(() => {
      try {
        const title = (document.querySelector("h1") || document.querySelector("h2"))?.innerText;

        for (const articleBodySelector of [
          'article > *[class*=body]',
          'article > *[class*=content]',
          'article',
          '*[class*="article" i]',
          '*[class*="content" i]',
        ]) {
          const element = document.querySelector(articleBodySelector) as HTMLElement | null;

          if (element?.innerText) {
            return {title, content: element.innerText};
          }
        }

        return {title, content: ""};

      } catch (e) {

        return {title: "", content: ""};

      }
    });
  }

  async getGoogleNewsArticlesBySearchQuery(searchQuery: string): Promise<ScraperRunReturn<{ articlesUrl: string[] }>> {
    return await Scraper
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto("https://news.google.com/"),
        Scraper.waitForNavigation(),
        Scraper.waitRandom(),
        Scraper.removeGPDR(),
        Scraper.waitForNavigation(),
        Scraper.waitRandom(),
        ...Scraper.searchAndEnter("input:not([aria-hidden=\"true\"])", searchQuery),
        Scraper.waitForNavigation(),
        Scraper.waitRandom(),
        Scraper.autoScroll(),
        Scraper.removeGPDR(),
        Scraper.waitForNavigation(),
        Scraper.waitRandom(),
        this.getArticlesUrls(),
      ])
      .run<{
        articlesUrl: string[],
      }>();
  }

  async getArticle(articleUrl: string): Promise<ScraperRunReturn<{ title?: string, content?: string }>> {
    return await Scraper
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto(articleUrl),
        Scraper.waitForNavigation(),
        Scraper.waitRandom(),
        Scraper.removeGPDR(),
        Scraper.waitForNavigation(),
        Scraper.waitRandom(),
        this.getArticleContent(),
      ])
      .run<{
        title?: string,
        content?: string,
      }>();
  }
}
