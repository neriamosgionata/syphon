import financeHandler from "yahoo-finance2";
import {Quote} from "yahoo-finance2/dist/esm/src/modules/quote";
import {ChartResultArray} from "yahoo-finance2/dist/esm/src/modules/chart";
import {QuoteSummaryResult} from "yahoo-finance2/dist/esm/src/modules/quoteSummary-iface";
import Scraper from "@ioc:Providers/Scraper";
import {ScraperHandlerFunction} from "App/Services/Scraper/BaseScraper";

export type ChartInterval =
  "1m"
  | "2m"
  | "5m"
  | "15m"
  | "30m"
  | "60m"
  | "90m"
  | "1h"
  | "1d"
  | "5d"
  | "1wk"
  | "1mo"
  | "3mo";

export type ChartOptions = {
  period1: Date | string | number;
  period2: Date | string | number;
  interval: ChartInterval;
}

export interface FinanceContract {
  getQuoteViaTicker(ticker: string): Promise<Quote>;

  getSummaryQuoteViaTicker(ticker: string): Promise<QuoteSummaryResult>;

  getChartViaTicker(ticker: string, fromDate: string | number, toDate?: string | number, interval?: ChartInterval): Promise<ChartResultArray>;

  scrapeYahooFinanceForTickerListEtfs(): Promise<string[]>;
}

export default class Finance implements FinanceContract {

  constructor(withoutLogger: boolean) {
    if (withoutLogger) {
      financeHandler.setGlobalConfig({
        logger: {
          info: () => {
          },
          warn: () => {
          },
          error: () => {
          },
          debug: () => {
          },
        }
      });
    }
  }


  public async getQuoteViaTicker(ticker: string): Promise<Quote> {
    return await financeHandler.quote(ticker);
  }

  public async getSummaryQuoteViaTicker(ticker: string): Promise<QuoteSummaryResult> {
    return await financeHandler.quoteSummary(ticker);
  }

  public async getChartViaTicker(ticker: string, fromDate: string | number, toDate?: string | number, interval: ChartInterval = "1d"): Promise<ChartResultArray> {
    const period1 = (new Date(fromDate)).toISOString();
    const period2 = toDate ? (new Date(toDate)).toISOString() : (new Date()).toISOString();

    const options: ChartOptions = {
      period1,
      period2,
      interval
    };

    return await financeHandler.chart(ticker, options);
  }

  //SCRAPING

  private crawlListOfTickersEtfs(): ScraperHandlerFunction<{ tickers: string[] }> {
    return Scraper.evaluate(() => {
      const selectorTable = "table tbody tr";

      const rows = document.querySelectorAll(selectorTable);

      if (rows.length === 0) {
        return {tickers: []};
      }

      const tickers: string[] = [];

      rows.forEach((row) => {
        const ticker = row.querySelector("td:nth-child(1) a")?.textContent;
        if (ticker) {
          tickers.push(ticker);
        }
      });

      return {tickers};
    })
  }

  public async scrapeYahooFinanceForTickerListEtfs() {
    let offset = 0;
    let count = 100;

    let tickersFound: string[] = [];

    let res = await Scraper
      .setScraperStatusName("newsletter-get-single-article")
      .setWithAdblockerPlugin(true)
      .setWithStealthPlugin(true)
      .setHandlers([
        Scraper.goto(`https://finance.yahoo.com/etfs?offset=${offset}&count=${count}`),
        Scraper.waitRandom(),
        Scraper.removeGPDR(),
        this.crawlListOfTickersEtfs(),
      ])
      .run<{ tickers: string[] }>();

    tickersFound.push(...(res.results?.tickers || []));

    while ((res.results?.tickers || []).length > 0) {
      res = await Scraper
        .setScraperStatusName("newsletter-get-single-article")
        .setWithAdblockerPlugin(true)
        .setWithStealthPlugin(true)
        .setHandlers([
          Scraper.goto(`https://finance.yahoo.com/etfs?offset=${offset}&count=${count}`),
          Scraper.waitRandom(),
          Scraper.removeGPDR(),
          this.crawlListOfTickersEtfs(),
        ])
        .run<{ tickers: string[] }>();

      tickersFound.push(...(res.results?.tickers || []));

      offset += count;
    }

    return tickersFound;
  }

}
