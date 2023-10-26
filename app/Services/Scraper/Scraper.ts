import Logger from "@ioc:Providers/Logger";
import {Browser, BrowserContext, executablePath, Page} from "puppeteer";
import puppeteer from 'puppeteer-extra';
import ScraperStatus from "App/Models/ScraperStatus";

export type TestFunction = (_browser: Browser, _page: Page) => Promise<boolean>;
export type HandlerFunction<T extends { [p: string | number]: any }> = (_browser: Browser, _page: Page) => Promise<T>;

export interface ScraperContract {
  run(): Promise<any>;

  startTask(): Promise<void>;

  runPuppeteer(): Promise<void>;

  endTask(): Promise<void>;

  handle(): Promise<{}>;

  test(): Promise<boolean>;

  goto(href: string): Promise<void>;

  clearScraperStatus(name: string, status: object | any): Promise<void>;

  resetScraperStatus(): Promise<void>;

  updateScraperStatus(status: object | any): Promise<void>;

  registerError(error: Error | any, key: string): Promise<void>;

  writeTableLog(table: any[]): Promise<void>;

  writeLog(level: string, message: string, ...values: unknown[]): Promise<void>;

  checkForCaptcha(page: Page): Promise<boolean>;

  waitRandom(): Promise<void>;

  removeCookiesHref(page: Page): Promise<void>;

  setRegisteredTests(testsFunctions: TestFunction[]): void;

  setRegisteredHandlers(handlersFunctions: HandlerFunction<any>[]): void;
}

export default class Scraper implements ScraperContract {
  private defaultStatus: any = {};
  private scraperStatus: any = this.defaultStatus;

  private readonly errors: Error[] = [];
  private readonly reports: string[] = [];

  private withPuppeteer: boolean = true;
  private browser!: Browser;
  private page!: Page;

  private context: BrowserContext;

  private registeredTests: TestFunction[] = [];
  private registeredHandlers: HandlerFunction<any>[] = [];

  constructor(
    protected headlessChrome: boolean = true,
    protected writeOnConsole: boolean = false,
    protected logChannel: string = "default"
  ) {
    Logger.channel(this.logChannel);
  }

  setRegisteredTests(testsFunctions: TestFunction[]): void {
    this.registeredTests = testsFunctions;
  }

  setRegisteredHandlers(handlersFunctions: HandlerFunction<any>[]): void {
    this.registeredHandlers = handlersFunctions;
  }

  //SETUP

  async run(): Promise<any> {
    await this.startTask();

    await this.writeLog('info', "-> testing task service functionalities");

    if (!(await this.test())) {
      await this.registerError(new Error('Initial test was not successful, skipping task'), "Test");
      return null;
    }

    let result: any = null;
    try {
      result = await this.handle();
    } catch (err) {
      await this.registerError(err, "Generic");
    }

    await this.endTask();

    return result;
  }

  async startTask() {
    if (this.withPuppeteer) {
      await this.runPuppeteer();
    }
  }

  async runPuppeteer(): Promise<void> {
    const args = [...new Set([
      "--single-process",
      "--allow-running-insecure-content",
      "--autoplay-policy=user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process",
      "--disable-ipc-flooding-protection",
      "--disable-print-preview",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--disable-site-isolation-trials",
      "--disable-speech-api",
      "--disable-web-security",
      "--disk-cache-size=1073741824",
      "--enable-features",
      "--enable-features=SharedArrayBuffer,NetworkService,NetworkServiceInProcess",
      "--hide-scrollbars",
      "--ignore-gpu-blocklist",
      "--in-process-gpu",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-pings",
      "--no-sandbox",
      "--no-zygote",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--window-size=1920,1080",
      "--disable-gpu",
      "--ignore-certificate-errors",
      "--lang=en-US,en",
      "--enable-automation",
      "--no-default-browser-check",
      "--force-dev-mode-highlighting",
    ])];

    const launchArgs = {
      executablePath: executablePath(),
      defaultViewport: {
        deviceScaleFactor: 1,
        hasTouch: false,
        height: 1080,
        isLandscape: true,
        isMobile: false,
        width: 1920,
      },
      headless: this.headlessChrome,
      args
    };

    this.browser = await puppeteer.launch(launchArgs);
    this.context = await this.browser.createIncognitoBrowserContext();
    this.page = await this.browser.newPage();
  }

  async endTask(): Promise<void> {
    if (this.context && this.context.close) {
      await this.context.close();
    }

    if (this.browser && this.browser.close) {
      await this.browser.close();
    }

    if (this.reports.length) {
      await this.writeLog('info', '\n\r');
      await this.writeLog('info', 'Reports count: ' + this.reports.length);
      await this.writeLog('info', 'List:');
      await this.writeTableLog(['REPORTS', ...this.reports]);
    }

    if (this.errors.length) {
      await this.writeLog('error', '\n\r');
      await this.writeLog('error', 'Errors count: ' + this.errors.length);
      await this.writeLog('error', 'List:');
      await this.writeTableLog(['ERRORS', ...this.errors.map((e) => e.message)]);
    }

    await this.writeLog('info', '\n\r');
  }

  async handle(): Promise<{}> {
    const result: any = {};

    await this.writeLog('info', "-> handling function to puppeteer");

    for (const funcIndex in this.registeredHandlers) {
      try {
        const res = await this.registeredHandlers[funcIndex](this.browser, this.page);
        Object.assign(result, res);
      } catch (err) {
        await this.registerError(new Error('Handler failed, func index: ' + funcIndex), "Handler_failed_" + funcIndex);
        await this.registerError(err, "Handler_failed_" + funcIndex);
      }
    }

    return result;
  }

  async test(): Promise<boolean> {
    await this.writeLog('info', "-> testing function to puppeteer");

    for (const funcIndex in this.registeredTests) {
      try {
        if (!(await this.registeredTests[funcIndex](this.browser, this.page))) {
          await this.registerError(new Error('Test failed, func index: ' + funcIndex), "Test_failed_" + funcIndex);
          return false;
        }
      } catch (err) {
        await this.registerError(err, "Test");
        return false;
      }
    }

    return true;
  }

  //HELPERS

  async goto(href: string): Promise<void> {
    if (this.page) {
      try {
        await Promise.all([
          this.page.waitForNavigation({timeout: 10000}),
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

  async clearScraperStatus(name: string, status: object | any): Promise<void> {
    this.scraperStatus = {
      name,
      status
    };
  }

  async resetScraperStatus(): Promise<void> {
    await ScraperStatus
      .query()
      .where('name', this.scraperStatus.name)
      .update({
        status: this.defaultStatus
      })
      .exec();
  }

  async updateScraperStatus(status: object | any): Promise<void> {
    Object
      .keys(this.scraperStatus.status)
      .forEach((key) => {
        if (status[key] !== undefined && typeof status[key] === "number") {
          this.scraperStatus.status[key] += +status[key];
        } else if (status[key] !== undefined) {
          this.scraperStatus.status[key] = status[key];
        }
      });

    await ScraperStatus
      .query()
      .where('name', this.scraperStatus.name)
      .update({
        status: this.defaultStatus
      })
      .exec();
  }

  async registerError(error: Error | any, key: string): Promise<void> {
    this.errors.push(error);

    await Logger.channel(this.logChannel).error(
      "Key: " + key + ", Error occurred: " + error.message,
      error?.stack?.split('\n')?.shift() || "Error stack is empty",
      error?.response?.data || error?.data || "Empty data",
      error?.params?.data || error?.params || "Empty params"
    );

    if (this.writeOnConsole) {
      console.error("Error message: ", error.message);
      console.error("Error stack: ", error.stack);
      console.error("Error data: ", error?.response?.data || error?.data || "Empty data");
      console.error("Error params: ", error?.params?.data || error?.params || "Empty params");
    }
  }

  async writeTableLog(table: any[]): Promise<void> {
    await Logger.channel(this.logChannel).table(table);

    if (this.writeOnConsole) {
      console.table(table);
    }
  }

  async writeLog(level: string, message: string, ...values: unknown[]): Promise<void> {
    await Logger.channel(this.logChannel)[level.trim()](message, ...values);

    if (this.writeOnConsole) {
      console[level](message, ...values);
    }
  }

  async checkForCaptcha(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
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
}
