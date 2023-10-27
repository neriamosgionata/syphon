import {Page} from "puppeteer";
import BaseScraper, {
  BaseScraperContract,
  HandlerFunction,
  HandlerReturn,
  RunReturn,
  TestFunction
} from "App/Services/Scraper/BaseScraper";

export interface ScraperContract extends BaseScraperContract {
  run<T extends HandlerReturn<any>>(): Promise<RunReturn<T>>;

  //SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): ScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): ScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): ScraperContract;

  setLoggerChannel(logChannel: string, writeOnConsole: boolean): ScraperContract;

  setTests(testsFunctions: TestFunction[]): ScraperContract;

  setHandlers(handlersFunctions: HandlerFunction<any>[]): ScraperContract;

  setScraperStatusName(name: string): ScraperContract;

  resetScraperStatus(): Promise<void>;

  updateScraperStatus(status: object | any): Promise<void>;

  registerError(error: Error | any, key: string): Promise<void>;

  writeTableLog(table: any[]): Promise<void>;

  writeLog(level: string, message: string, ...values: unknown[]): Promise<void>;

  //HELPERS

  goto(href: string, timeoutMs: number): Promise<void>;

  checkForCaptcha(page: Page): Promise<boolean>;

  waitRandom(): Promise<void>;

  removeCookiesHref(page: Page): Promise<void>;

  typeIn(selector: string, text: string, options?: { delay: number }): Promise<void>;

  keyEnter(selector: string, options?: { delay: number }): Promise<void>;

  click(selector: string): Promise<void>;

  focus(selector: string): Promise<void>;

  searchAndEnter(inputSelector: string, searchQuery: string): Promise<void>;

  evaluate<T>(fn: (...args: any[]) => T): Promise<T>;
}

export default class Scraper extends BaseScraper implements ScraperContract {
  constructor(
    protected headlessChrome: boolean = true,
    protected writeOnConsole: boolean = false,
    protected scraperStatusName: string = "",
  ) {
    super(headlessChrome, writeOnConsole, scraperStatusName);
  }

  //HELPERS

  async goto(href: string, timeoutMs: number = 10000): Promise<void> {
    if (this.page) {
      try {
        await Promise.all([
          this.page.waitForNavigation({timeout: timeoutMs}),
          this.page.goto(href, {
            waitUntil: ['networkidle2', 'domcontentloaded'],
          })
        ]);
      } catch (e) {
        await this.registerError(e, "goto");
      }
      return;
    }
    throw new Error("Page is not ready");
  }

  checkForCaptcha(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const selectors = [...document.querySelectorAll('iframe')] as HTMLIFrameElement[];
      return selectors.filter((selector) => selector?.src?.includes('captcha')).length > 0;
    });
  }

  async waitRandom(): Promise<void> {
    await new Promise((res) => setTimeout(res, 87 + Math.random() * 5000));
  }

  async removeCookiesHref(page: Page): Promise<void> {
    const client = await page.target().createCDPSession();
    const cookies = (await client.send('Network.getAllCookies')).cookies;
    await page.deleteCookie(...cookies);
  }

  async typeIn(selector: string, text: string, options: { delay: number } = {delay: 0}): Promise<void> {
    if (this.page) {
      try {
        await this.page.evaluate((selector) => {
          const element = (document.querySelector(selector) as HTMLInputElement);
          element.focus();
          element.value = "";
        }, selector);

        for (const item of [...text]) {
          await this.page.type(selector, item, options);
          await new Promise((resolve) => setTimeout(resolve, 32 + (Math.random() * 137)));
        }
      } catch (e) {
        await this.registerError(e, "typeIn");
      }
      return;
    }
    throw new Error("Page is not ready");
  }

  async keyEnter(selector: string, options: { delay: number } = {delay: 0}): Promise<void> {
    if (this.page) {
      try {
        await this.page.evaluate((selector) => {
          const element = (document.querySelector(selector) as HTMLInputElement);
          element.focus();
        }, selector);

        await new Promise((resolve) => setTimeout(resolve, options.delay ?? (32 + (Math.random() * 137))));

        await this.page.keyboard.press("Enter");
      } catch (e) {
        await this.registerError(e, "keyEnter");
      }
      return;
    }
    throw new Error("Page is not ready");
  }

  async evaluate<T>(fn: (...args: any[]) => T): Promise<T> {
    if (this.page) {
      try {
        return await this.page.evaluate(fn);
      } catch (e) {
        await this.registerError(e, "evaluate");
      }
      return true as T;
    }
    throw new Error("Page is not ready");
  }

  async click(selector: string): Promise<void> {
    if (this.page) {
      try {
        await this.page.click(selector);
      } catch (e) {
        await this.registerError(e, "click");
      }
      return;
    }
    throw new Error("Page is not ready");
  }

  async focus(selector: string): Promise<void> {
    if (this.page) {
      try {
        await this.page.focus(selector);
      } catch (e) {
        await this.registerError(e, "focus");
      }
      return;
    }
    throw new Error("Page is not ready");
  }

  async searchAndEnter(inputSelector: string, searchQuery: string): Promise<void> {
    await this.typeIn(inputSelector, searchQuery, {delay: 33})
    await this.keyEnter(inputSelector, {delay: 37});
    await this.waitRandom();
  }
}
