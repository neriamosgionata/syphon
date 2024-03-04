import {Browser, Page} from "puppeteer";
import BaseScraper, {
  BaseScraperContract,
  ScraperHandlerFunction,
  ScraperHandlerReturn,
  ScraperRunReturn,
  ScraperTestFunction
} from "App/Services/Scraper/BaseScraper";
import Drive from "@ioc:Adonis/Core/Drive";
import {LogChannels} from "App/Services/Logger/Logger";

export interface ScraperContract extends BaseScraperContract {
  end(): Promise<void>;

  run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>>;

  openNewPage(): Promise<Page>;

  getRunResult<T>(): ScraperRunReturn<T>;

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean): ScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): ScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): ScraperContract;

  setLoggerChannel(logChannel: LogChannels, writeOnConsole: boolean): ScraperContract;

  setPrintInConsole(writeOnConsole: boolean): ScraperContract;

  setTakeScreenshot(takeScreenshot: boolean): ScraperContract;

  setDebugConsole(debugConsole: boolean): ScraperContract;

  setTests(testsFunctions: ScraperTestFunction[]): ScraperContract;

  setHandlers(handlersFunctions: ScraperHandlerFunction<any>[]): ScraperContract;

  setArguments(args: { [p: string]: any }): ScraperContract;

  setCloseOnExit(closeOnExit: boolean): ScraperContract;

  setEnableProxy(enableProxy: boolean): ScraperContract;

  addHandler(handlerFunction: ScraperHandlerFunction<any>): ScraperContract;

  registerError(error: Error | any, key: string): void;

  writeTableLog(table: any[]): void;

  writeLog(level: string, message: string, ...values: unknown[]): void;

  //HELPERS

  goto(href: string, timeoutMs?: number): ScraperHandlerFunction<void>;

  checkForCaptcha(): ScraperHandlerFunction<boolean>;

  waitRandom(enlarge?: boolean): ScraperHandlerFunction<void>;

  removeCookiesHref(): ScraperHandlerFunction<void>;

  typeIn(selector: string, text: string, options?: { delay: number }): ScraperHandlerFunction<void>;

  keyEnter(selector: string, options?: { delay: number }): ScraperHandlerFunction<void>;

  click(selector: string): ScraperHandlerFunction<void>;

  focus(selector: string): ScraperHandlerFunction<void>;

  searchAndEnter(inputSelector: string, searchQuery: string): ScraperHandlerFunction<void>[];

  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): ScraperHandlerFunction<T>;

  takeScreenshot(name?: string): ScraperHandlerFunction<void>;

  removeGPDR(): ScraperHandlerFunction<void>;

  repeat(fn: ScraperHandlerFunction<any>, times: number, timeoutBetweenRepetition?: number): ScraperHandlerFunction<any>;

  autoScroll(maxScrolls?: number): ScraperHandlerFunction<void>;

  waitForNavigation(timeout?: number): ScraperHandlerFunction<void>;
}

export default class Scraper extends BaseScraper implements ScraperContract {
  constructor(
    protected withHeadlessChrome: boolean = true,
    protected writeOnConsole: boolean = false,
    protected debugConsole: boolean = false,
    protected withAdblockerPlugin: boolean = true,
    protected withStealthPlugin: boolean = true,
    protected removeUserDataOnExit: boolean = true,
    protected enableProxy: boolean = true,
    protected logChannel: LogChannels = "scraper",
  ) {
    super(
      withHeadlessChrome,
      writeOnConsole,
      debugConsole,
      withAdblockerPlugin,
      withStealthPlugin,
      removeUserDataOnExit,
      enableProxy,
      logChannel,
    );
  }

  //HELPERS

  goto(href: string, timeoutMs: number = 60000): ScraperHandlerFunction<void> {
    return async (_browser: Browser, _page) => {
      if (_page) {
        await Promise.allSettled([
          _page.waitForNavigation({timeout: timeoutMs}),
          _page.goto(href, {
            waitUntil: ['networkidle2', 'domcontentloaded'],
          })
        ]);
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  checkForCaptcha(): ScraperHandlerFunction<boolean> {
    return async (_browser, _page) => {
      return _page.evaluate(() => {
        const selectors = [...document.querySelectorAll('iframe')] as HTMLIFrameElement[];
        return selectors.filter((selector) => selector?.src?.includes('captcha')).length > 0;
      });
    }
  }

  waitRandom(enlarge: boolean = false): ScraperHandlerFunction<void> {
    return async () => {
      await new Promise((res) => setTimeout(res, 87 + Math.random() * (enlarge ? 10000 : 3000)));
    }
  }

  removeCookiesHref(): ScraperHandlerFunction<void> {
    return async (_browser, page) => {
      const client = await page.target().createCDPSession();
      const cookies = (await client.send('Network.getAllCookies')).cookies;
      await page.deleteCookie(...cookies);
    }
  }

  typeIn(selector: string, text: string, options: { delay: number } = {delay: 0}): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      if (_page) {
        await _page.evaluate((selector) => {
          const element = (document.querySelector(selector) as HTMLInputElement);
          element.focus();
          element.value = "";
        }, selector);

        for (const item of [...text]) {
          await _page.type(selector, item, options);
          await new Promise((resolve) => setTimeout(resolve, 32 + (Math.random() * 137)));
        }
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  keyEnter(selector: string, options: { delay: number } = {delay: 0}): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      if (_page) {
        await _page.evaluate((selector) => {
          const element = (document.querySelector(selector) as HTMLInputElement);
          element.focus();
        }, selector);

        await new Promise((resolve) => setTimeout(resolve, options.delay ?? (32 + (Math.random() * 137))));

        await _page.keyboard.press("Enter");
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): ScraperHandlerFunction<T> {
    return async (_browser, _page) => {
      if (_page) {
        return await _page.evaluate(fn, ...args);
      }
      throw new Error("Page is not ready");
    }
  }

  click(selector: string): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      if (_page) {
        await _page.click(selector);
      }
      throw new Error("Page is not ready");
    }
  }

  focus(selector: string): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      if (_page) {
        await _page.focus(selector);
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  searchAndEnter(inputSelector: string, searchQuery: string): ScraperHandlerFunction<void>[] {
    return [
      this.typeIn(inputSelector, searchQuery, {delay: 33 + Math.random() * 137}),
      this.keyEnter(inputSelector, {delay: 37 + Math.random() * 137}),
      this.waitRandom(),
    ];
  }

  takeScreenshot(name?: string): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      if (_page) {
        const path = "screenshots";

        const fullPath = path + "/" + (name ?? "screenshot-") + Date.now() + ".png";
        const img = await _page.screenshot();

        await Drive.put(fullPath, img);
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  removeGPDR(): ScraperHandlerFunction<void> {
    return async (_browser, page) => {
      await page.evaluate(() => {
        const acceptTexts = [
          'accetta', 'accetta tutto', 'accetto', 'accept', 'accept all', 'agree', 'i agree', 'consent', 'ich stimme zu', 'acepto', 'j\'accepte',
          'alle akzeptieren', 'akzeptieren', 'verstanden', 'zustimmen', 'okay', 'ok', 'acconsento', 'accepter tout', 'accepter', 'accept all',
        ];

        const acceptREString = (
          '^([^a-zA-Z0-9]+)?'
          + acceptTexts.join('([^a-zA-Z0-9]+)?$|^([^a-zA-Z0-9]+)?')
          + '([^a-zA-Z0-9]+)?$'
        );

        const buttons = [
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('input[type="button"]'),
          ...document.querySelectorAll('input[type="submit"]'),
        ] as HTMLButtonElement[];

        for (const button of buttons) {
          if (button.innerText.toLowerCase().match(new RegExp(acceptREString, 'i'))) {
            button.click();
            return;
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 32 + Math.random() * 250));

      try {
        await page.waitForNavigation({timeout: 15000});
      } catch (e) {

      }
    }
  }

  autoScroll(maxScrolls: number = 50): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      await _page.evaluate(async (maxScrolls) => {

        await new Promise<void>((resolve) => {

          let totalHeight = 0;
          const distance = 100;
          let scrolls = 0;

          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            scrolls++;

            if (totalHeight >= scrollHeight - window.innerHeight || scrolls >= maxScrolls) {
              clearInterval(timer);
              resolve();
            }
          }, 450);

        });

      }, maxScrolls);
    }
  }

  repeat(fn: ScraperHandlerFunction<any>, times: number, timeoutBetweenRepetition: number = 1000): ScraperHandlerFunction<any> {
    return async (_browser, _page) => {
      let totalResult: any = {};

      for (let i = 0; i < times; i++) {
        const r = await fn(_browser, _page, this.args, totalResult);
        await _page.waitForNetworkIdle();
        await new Promise((resolve) => setTimeout(resolve, timeoutBetweenRepetition));
        totalResult = {...r};
      }

      return totalResult;
    }
  }

  waitForNavigation(timeout: number = 60000): ScraperHandlerFunction<void> {
    return async (_browser, _page) => {
      try {
        await _page.waitForNavigation({timeout});
      } catch (e) {

      }
    }
  }

}
