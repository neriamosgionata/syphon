import Scraper from "@ioc:Providers/Scraper";
import {ScraperHandlerFunction, ScraperRunReturn} from "App/Services/Scraper/BaseScraper";

export interface NewsletterContract {
  getGoogleNewsArticlesFor(searchQuery: string): Promise<ScraperRunReturn<{ articlesUrl: string[] }>>;

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

      }

      return {title: "", content: ""};
    });
  }

  async getGoogleNewsArticlesFor(searchQuery: string): Promise<ScraperRunReturn<{ articlesUrl: string[] }>> {
    return await Scraper
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto("https://news.google.com/"),
        ...Scraper.searchAndEnter("input:not([aria-hidden=\"true\"])", searchQuery),
        Scraper.autoScroll(50),
        this.getArticlesUrls(searchQuery),
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
        this.getArticleContent(),
      ])
      .run<{
        title?: string,
        content?: string,
      }>();
  }
}
