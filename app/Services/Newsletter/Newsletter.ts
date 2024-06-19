import Scraper from "@ioc:Providers/Scraper";
import {ScraperRunReturn} from "App/Services/Scraper/BaseScraper";
import Profile from "App/Models/Profile";

export interface NewsletterContract {
  getGoogleNewsArticlesByTickerProfile(profile: Profile): Promise<ScraperRunReturn<{ articlesUrl: string[] }>>;

  getArticle(articleUrl: string): Promise<ScraperRunReturn<{ title?: string, content?: string }>>;
}

export default class Newsletter implements NewsletterContract {

  async getGoogleNewsArticlesByTickerProfile(profile: Profile): Promise<ScraperRunReturn<{
    articlesUrl: string[]
  }>> {
    return await Scraper
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto("https://news.google.com/"),
        Scraper.waitForNavigation(),
        Scraper.removeGPDR(),
        Scraper.waitForNavigation(),
        ...Scraper.searchAndEnter("input:not([aria-hidden=\"true\"])", profile.getSearchQuery()),
        Scraper.waitForNavigation(),
        Scraper.removeGPDR(),
        Scraper.waitForNavigation(),
        Scraper.autoScroll(50, 2000),
        Scraper.evaluate(() => {
          const articles = document.querySelectorAll("main article");
          const articlesUrl: string[] = [];

          for (const article of articles) {
            const url = article.querySelector("a")?.getAttribute("href");
            if (url) {
              articlesUrl.push("https://news.google.com/" + url.replace("./", ""));
            }
          }

          return {articlesUrl};
        }),
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
        Scraper.removeGPDR(),
        Scraper.waitForNavigation(),
        Scraper.evaluate(() => {
          const selectors = [
            'article',
            '*[class*="article" i]',
            '*[class*="article-body" i]',
            '*[class*="content" i]',
            '*[class*="body" i]',
          ];

          try {
            for (const selector of selectors) {
              const element = document.querySelector(selector) as HTMLElement | null;

              if (element?.innerText) {
                return {content: element.innerText};
              }
            }

            return {content: ""};
          } catch (e) {
            return {content: ""};
          }
        }),
      ])
      .run<{
        title?: string,
        content?: string,
      }>();
  }
}
