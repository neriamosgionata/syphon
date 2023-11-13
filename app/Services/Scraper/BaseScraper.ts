import {Browser, BrowserContext, executablePath, Page} from "puppeteer";
import {LoggerContract} from "App/Services/Logger/Logger";
import Logger from "@ioc:Providers/Logger";
import ScraperStatus from "App/Models/ScraperStatus";

export type ScraperTestFunction = (_browser: Browser, _page: Page) => Promise<boolean>;

export type ScraperHandlerReturn<T extends ({ [p: string | number]: any } | null | undefined)> = T;

export type ScraperHandlerFunction<T extends ScraperHandlerReturn<any>> = (_browser: Browser, _page: Page) => Promise<T>;

export type ScraperRunReturn<T extends ScraperHandlerReturn<any>> = { results: T, errors: Error[] };

export interface BaseScraperContract {
  run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>>;

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): BaseScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): BaseScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): BaseScraperContract;

  setLoggerChannel(logChannel: string, writeOnConsole: boolean): BaseScraperContract;

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

  protected context: BrowserContext;

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

  // SETUP

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
      console.error("Error message: ", error.message);
      console.error("Error stack: ", error.stack);
    }
  }

  writeTableLog(table: any[]): void {
    this.logger.table(table);

    if (this.writeOnConsole) {
      console.table(table);
    }
  }

  writeLog(level: string, message: string, ...values: unknown[]): void {
    this.logger[level.trim()](message, ...values);

    if (this.writeOnConsole) {
      console[level](message, ...values);
    }
  }

  getErrors(): Error[] {
    return this.errors;
  }

  //HANDLER

  async run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>> {
    await this.start();

    this.writeLog('info', "-> testing task service functionalities");

    if (!(await this.test())) {
      await this.registerError(new Error('Initial test was not successful, skipping task'), "Tests");
      return {results: null as T, errors: this.errors};
    }

    let result: any = {};
    try {
      result = await this.handle<T>();
    } catch (err) {
      await this.registerError(err, "Generic");
    }

    await this.end();

    return {results: result, errors: this.errors};
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
    this.context = await this.browser.createIncognitoBrowserContext();
    this.page = await this.browser.newPage();
  }

  protected async end(): Promise<void> {
    if (this.context && this.context.close) {
      await this.context.close();
    }

    if (this.browser && this.browser.close) {
      await this.browser.close();
    }

    if (this.errors.length) {
      this.writeLog('error', '\n\r');
      this.writeLog('error', 'Errors count: ' + this.errors.length);
      this.writeLog('error', 'List:');
      this.writeTableLog(['ERRORS', ...this.errors.map((e) => e.message)]);
    }

    this.registeredHandlers = [];
    this.registeredTests = [];
  }

  protected async handle<T extends ScraperHandlerReturn<any>>(): Promise<T> {
    let result: T = {} as T;

    this.writeLog('info', "-> handling function to puppeteer");

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
    this.writeLog('info', "-> testing function to puppeteer");

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
