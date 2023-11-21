import {Browser, executablePath, Page} from "puppeteer";
import {LoggerContract} from "App/Services/Logger/Logger";
import Logger from "@ioc:Providers/Logger";
import ScraperStatus from "App/Models/ScraperStatus";
import Console from "@ioc:Providers/Console";

export type ScraperTestFunction = (_browser: Browser, _page: Page) => Promise<boolean>;

export type ScraperHandlerReturn<T extends ({ [p: string | number]: any } | null | undefined)> = T;

export type ScraperHandlerFunction<T extends ScraperHandlerReturn<any>> = (_browser: Browser, _page: Page) => Promise<T>;

export type ScraperRunReturn<T extends ScraperHandlerReturn<any>> = { results: T, errors: Error[] };

export interface BaseScraperContract {
  run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>>;

  openNewPage(): Promise<Page>;

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): BaseScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): BaseScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): BaseScraperContract;

  setLoggerChannel(logChannel: string, writeOnConsole: boolean): BaseScraperContract;

  setPrintInConsole(writeOnConsole: boolean): BaseScraperContract;

  setTests(testsFunctions: ScraperTestFunction[]): BaseScraperContract;

  setHandlers(handlersFunctions: ScraperHandlerFunction<any>[]): BaseScraperContract;

  setScraperStatusName(name: string): BaseScraperContract;

  getErrors(): Error[];

  resetScraperStatus(): Promise<void>;

  updateScraperStatus(status: object | any): Promise<void>;

  registerError(error: Error | any, key: string): Promise<void>;

  writeTableLog(table: any[]): void;

  writeLog(level: string, message: string, ...values: unknown[]): void;
}

export default class BaseScraper implements BaseScraperContract {
  protected defaultStatus: { name: string, status: { [p: string | number]: any } } = {name: "", status: {}};
  protected scraperStatus: typeof this.defaultStatus = this.defaultStatus;

  protected readonly errors: Error[] = [];

  protected browser!: Browser;
  protected page!: Page;

  private extraOpenedPages: Page[] = [];

  protected registeredTests: ScraperTestFunction[] = [];
  protected registeredHandlers: ScraperHandlerFunction<any>[] = [];

  protected logger: LoggerContract;

  protected withStealthPlugin: boolean = false;
  protected withAdblockerPlugin: boolean = false;

  constructor(
    protected withHeadlessChrome: boolean | string = true,
    protected writeOnConsole: boolean = false,
    protected logChannel: string = "default",
  ) {
    this.logger = Logger.logger(logChannel, "scraper", writeOnConsole);
  }

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): this {
    this.withHeadlessChrome = headlessChrome;
    return this;
  }

  setWithStealthPlugin(withStealthPlugin: boolean): this {
    this.withStealthPlugin = withStealthPlugin;
    return this;
  }

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): this {
    this.withAdblockerPlugin = withAdblockerPlugin;
    return this;
  }

  setPrintInConsole(writeOnConsole: boolean): this {
    this.writeOnConsole = writeOnConsole;
    return this;
  }

  setLoggerChannel(logChannel: string, writeOnConsole: boolean = false): this {
    this.logger = Logger.logger(logChannel, "scraper", writeOnConsole);
    return this;
  }

  setTests(testsFunctions: ScraperTestFunction[]): this {
    this.registeredTests = testsFunctions;
    return this;
  }

  setHandlers(handlersFunctions: ScraperHandlerFunction<any>[]): this {
    this.registeredHandlers = handlersFunctions;
    return this;
  }

  setScraperStatusName(name: string): this {
    this.defaultStatus = {
      name,
      status: {}
    };
    return this;
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
    const newErr = new Error(key + ": " + error.message);
    newErr.stack = error.stack;
    this.errors.push(error);

    if (this.writeOnConsole) {
      Console.error("Error message: ", error.message);
      Console.error("Error stack: ", error.stack);
    }
  }

  writeTableLog(table: any[]): void {
    this.logger.table(table);

    if (this.writeOnConsole) {
      Console.table(table);
    }
  }

  writeLog(level: string, message: string, ...values: unknown[]): void {
    this.logger[level.trim()](message, ...values);

    if (this.writeOnConsole) {
      Console[level](message, ...values);
    }
  }

  getErrors(): Error[] {
    return this.errors;
  }

  //HANDLER

  async run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>> {
    try {
      await this.start();
    } catch (e) {
      await this.registerError(e, "Start");
      await this.end();
      return {results: {} as T, errors: this.errors};
    }

    try {
      if (!(await this.test())) {
        await this.registerError(new Error('Initial test was not successful, skipping task'), "Tests");
        await this.end();
        return {results: {} as T, errors: this.errors};
      }
    } catch (e) {
      await this.registerError(e, "Start");
      await this.end();
      return {results: {} as T, errors: this.errors};
    }

    let result: any = {};

    try {
      result = await this.handle<T>();
    } catch (err) {
      await this.registerError(err, "Generic");
    } finally {
      await this.end();
    }

    return {results: result, errors: this.getErrors()};
  }

  protected async start() {
    await this.runPuppeteer();
  }

  protected async runPuppeteer(): Promise<void> {
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
      headless: this.withHeadlessChrome,
      args,
      protocolTimeout: 300000,
    };

    const puppeteer = (await import("puppeteer-extra")).default;
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    const AdblockerPlugin = (await import("puppeteer-extra-plugin-adblocker")).default;

    if (this.withStealthPlugin) {
      puppeteer.use(StealthPlugin());
    }

    if (this.withAdblockerPlugin) {
      puppeteer.use(AdblockerPlugin());
    }

    // @ts-ignore
    this.browser = await puppeteer.launch(launchArgs);
    this.page = await this.browser.newPage();

    if (this.writeOnConsole) {
      this.page.on('console', async (msg) => {
        try {
          const msgArgs = msg.args();
          for (const element of msgArgs) {
            Console.log(await element.jsonValue());
          }
        } catch (e) {

        }
      });
    }
  }

  async openNewPage(): Promise<Page> {
    const page = await this.browser.newPage();

    if (this.writeOnConsole) {
      page.on('console', async (msg) => {
        try {
          const msgArgs = msg.args();
          for (const element of msgArgs) {
            Console.log(await element.jsonValue());
          }
        } catch (e) {

        }
      });
    }

    this.extraOpenedPages.push(page);

    return page;
  }

  protected async end(): Promise<void> {
    if (this.page && this.page.close && !this.page.isClosed()) {
      await this.page.close();
    }

    for (const page of this.extraOpenedPages) {
      if (page && page.close && !page.isClosed()) {
        await page.close();
      }
    }

    if (this.browser && this.browser.close && this.browser.connected) {
      await this.browser.close();
    }

    if (this.errors.length) {
      this.writeLog('error', '\n\r');
      this.writeLog('error', 'Errors count: ' + this.errors.length);
      this.writeLog('error', 'List:');
      this.writeTableLog([...this.errors]);
    }

    this.registeredHandlers = [];
    this.registeredTests = [];
  }

  protected async handle<T extends ScraperHandlerReturn<any>>(): Promise<T> {
    let result: T = {} as T;

    for (const funcIndex in this.registeredHandlers) {
      try {
        const res = await this.registeredHandlers[funcIndex](this.browser, this.page);
        if (res !== undefined && res !== null) {
          result = {...res};
        }
      } catch (err) {
        await this.registerError(new Error('Handler failed, func index: ' + funcIndex), "Handler_failed_" + funcIndex);
        await this.registerError(err, "Handler_failed_" + funcIndex);
      }
    }

    return result;
  }

  protected async test(): Promise<boolean> {
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
}
