import {Browser, Page} from "puppeteer";
import BaseScraper, {
  BaseScraperContract,
  HandlerFunction,
  HandlerReturn,
  RunReturn,
  TestFunction
} from "App/Services/Scraper/BaseScraper";
import Config from "@ioc:Adonis/Core/Config";
import fs from "fs";

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

  //HELPERS

  goto(href: string, timeoutMs: number): HandlerFunction<void>;

  checkForCaptcha(page: Page): HandlerFunction<boolean>;

  waitRandom(): HandlerFunction<void>;

  removeCookiesHref(page: Page): HandlerFunction<void>;

  typeIn(selector: string, text: string, options?: { delay: number }): HandlerFunction<void>;

  keyEnter(selector: string, options?: { delay: number }): HandlerFunction<void>;

  click(selector: string): HandlerFunction<void>;

  focus(selector: string): HandlerFunction<void>;

  searchAndEnter(inputSelector: string, searchQuery: string): HandlerFunction<void>[];

  evaluate<T>(fn: (...args: any[]) => T): HandlerFunction<T>;

  takeScreenshot(): HandlerFunction<void>;

  removeGoogleGPDR(): HandlerFunction<void>;
}

export default class Scraper extends BaseScraper implements ScraperContract {
  constructor(
    protected headlessChrome: boolean | string = true,
    protected writeOnConsole: boolean = false,
    protected logChannel: string = "default",
  ) {
    super(headlessChrome, writeOnConsole, logChannel);
  }

  //HELPERS

  goto(href: string, timeoutMs: number = 10000): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
      if (_page) {
        await Promise.all([
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

  checkForCaptcha(): HandlerFunction<boolean> {
    return async (_browser: Browser, _page: Page) => {
      return _page.evaluate(() => {
        const selectors = [...document.querySelectorAll('iframe')] as HTMLIFrameElement[];
        return selectors.filter((selector) => selector?.src?.includes('captcha')).length > 0;
      });
    }
  }

  waitRandom(): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
      await new Promise((res) => setTimeout(res, 87 + Math.random() * 5000));
    }
  }

  removeCookiesHref(page: Page): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
      const client = await page.target().createCDPSession();
      const cookies = (await client.send('Network.getAllCookies')).cookies;
      await page.deleteCookie(...cookies);
    }
  }

  typeIn(selector: string, text: string, options: { delay: number } = {delay: 0}): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
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

  keyEnter(selector: string, options: { delay: number } = {delay: 0}): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
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

  evaluate<T>(fn: (...args: any[]) => T): HandlerFunction<T> {
    return async (_browser: Browser, _page: Page) => {
      if (_page) {
        return await _page.evaluate(fn);
      }
      throw new Error("Page is not ready");
    }
  }

  click(selector: string): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
      if (_page) {
        await _page.click(selector);
      }
      throw new Error("Page is not ready");
    }
  }

  focus(selector: string): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
      if (_page) {
        await _page.focus(selector);
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  searchAndEnter(inputSelector: string, searchQuery: string): HandlerFunction<void>[] {
    return [
      this.typeIn(inputSelector, searchQuery, {delay: 33}),
      this.keyEnter(inputSelector, {delay: 37}),
      this.waitRandom(),
    ];
  }

  takeScreenshot(): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {
      if (_page) {
        const path = Config.get("app.storage.data_folder") + "/screenshots";

        if (!fs.existsSync(path)) {
          fs.mkdirSync(path, {recursive: true});
        }

        const fullPath = path + "/screenshot-" + Date.now() + ".png";
        await _page.screenshot({path: fullPath});
        return;
      }
      throw new Error("Page is not ready");
    }
  }

  removeGoogleGPDR(): HandlerFunction<void> {
    return async (_browser: Browser, _page: Page) => {

      for (const context of _page.frames()) {
        await context.evaluate(() => {
          const acceptTexts = [
            'accetta', 'accetta tutto', 'accetto', 'accept', 'accept all', 'agree', 'i agree', 'consent', 'ich stimme zu', 'acepto', 'j"accepte',
            'alle akzeptieren', 'akzeptieren', 'verstanden', 'zustimmen', 'okay', 'ok', 'acconsento'
          ];

          const acceptREString = (
            '^([^a-zA-Z0-9]+)?'
            + acceptTexts.join('([^a-zA-Z0-9]+)?$|^([^a-zA-Z0-9]+)?')
            + '([^a-zA-Z0-9]+)?$'
          );

          const buttons = [...document.querySelectorAll('button'), ...document.querySelectorAll('input[type="button"]')] as HTMLButtonElement[];

          for (let button of buttons) {
            if (button.innerText.toLowerCase().match(new RegExp(acceptREString, 'i'))) {
              button.click();
              return;
            }
          }
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 32 + Math.random() * 250));

      await _page.waitForNavigation({timeout: 10000});
    }
  }

}
