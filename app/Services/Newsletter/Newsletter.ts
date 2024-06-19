import Scraper from "@ioc:Providers/Scraper";
import {ScraperRunReturn} from "App/Services/Scraper/BaseScraper";
import Profile from "App/Models/Profile";

export interface NewsletterContract {
  getGoogleNewsArticlesByTickerProfile(profile: Profile): Promise<ScraperRunReturn<{ articlesUrl: string[] }>>;

  getArticle(articleUrl: string): Promise<ScraperRunReturn<{ content?: string }>>;
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
        Scraper.autoScroll(10, 2000),
        Scraper.evaluate(() => {
          const articles = document.querySelectorAll("main c-wiz article");
          const articlesUrl: string[] = [];

          for (const article of articles) {
            if (article.classList.length <= 1) { // Filter only visible articles
              continue;
            }

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

  async getArticle(articleUrl: string): Promise<ScraperRunReturn<{ content?: string }>> {
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
            'article p',
            'article',
          ];

          try {
            for (const selector of selectors) {
              const element = [...document.querySelectorAll(selector)] as HTMLElement[];

              if (element.length > 0) {
                return {content: element.map((el) => el.innerText).join("\n")};
              }

            }

            return {content: ""};
          } catch (e) {
            return {content: ""};
          }
        }),
      ])
      .run<{
        content?: string,
      }>();
  }
}
