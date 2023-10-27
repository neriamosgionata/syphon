import {Browser, BrowserContext, executablePath, Page} from "puppeteer";
import {LoggerContract} from "App/Services/Logger/Logger";
import Logger from "@ioc:Providers/Logger";
import ScraperStatus from "App/Models/ScraperStatus";

export type TestFunction = (_browser: Browser, _page: Page) => Promise<boolean>;

export type HandlerReturn<T extends ({ [p: string | number]: any } | null | undefined)> = T;

export type HandlerFunction<T extends HandlerReturn<any>> = (_browser: Browser, _page: Page) => Promise<T>;

export type RunReturn<T extends HandlerReturn<any>> = { results: T, errors: Error[] };

export interface BaseScraperContract {
  run<T extends HandlerReturn<any>>(): Promise<RunReturn<T>>;

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): BaseScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): BaseScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): BaseScraperContract;

  setLoggerChannel(logChannel: string, writeOnConsole: boolean): BaseScraperContract;

  setTests(testsFunctions: TestFunction[]): BaseScraperContract;

  setHandlers(handlersFunctions: HandlerFunction<any>[]): BaseScraperContract;

  setScraperStatusName(name: string): BaseScraperContract;

  getErrors(): Error[];

  resetScraperStatus(): Promise<void>;

  updateScraperStatus(status: object | any): Promise<void>;

  registerError(error: Error | any, key: string): Promise<void>;

  writeTableLog(table: any[]): Promise<void>;

  writeLog(level: string, message: string, ...values: unknown[]): Promise<void>;
}

export default class BaseScraper implements BaseScraperContract {
  protected defaultStatus: { name: string, status: { [p: string | number]: any } } = {name: "", status: {}};
  protected scraperStatus: typeof this.defaultStatus = this.defaultStatus;

  protected readonly errors: Error[] = [];

  protected browser!: Browser;
  protected page!: Page;

  protected context: BrowserContext;

  protected registeredTests: TestFunction[] = [];
  protected registeredHandlers: HandlerFunction<any>[] = [];

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

  setTests(testsFunctions: TestFunction[]): this {
    this.registeredTests = testsFunctions;
    return this;
  }

  setHandlers(handlersFunctions: HandlerFunction<any>[]): this {
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

  async writeTableLog(table: any[]): Promise<void> {
    this.logger.table(table);

    if (this.writeOnConsole) {
      console.table(table);
    }
  }

  async writeLog(level: string, message: string, ...values: unknown[]): Promise<void> {
    this.logger[level.trim()](message, ...values);

    if (this.writeOnConsole) {
      console[level](message, ...values);
    }
  }

  getErrors(): Error[] {
    return this.errors;
  }

  //HANDLER

  async run<T extends HandlerReturn<any>>(): Promise<RunReturn<T>> {
    await this.start();

    await this.writeLog('info', "-> testing task service functionalities");

    if (!(await this.test())) {
      await this.registerError(new Error('Initial test was not successful, skipping task'), "Tests");
      return {results: null as T, errors: this.errors};
    }

    let result: any = {};
    try {
      result = await this.handle();
    } catch (err) {
      await this.registerError(err, "Generic");
    }

    await this.end();

    return {results: result as T, errors: this.errors};
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
      args
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
      await this.writeLog('error', '\n\r');
      await this.writeLog('error', 'Errors count: ' + this.errors.length);
      await this.writeLog('error', 'List:');
      await this.writeTableLog(['ERRORS', ...this.errors.map((e) => e.message)]);
    }

    this.registeredHandlers = [];
    this.registeredTests = [];
  }

  protected async handle(): Promise<{}> {
    const result: any = {};

    await this.writeLog('info', "-> handling function to puppeteer");

    for (const funcIndex in this.registeredHandlers) {
      try {
        const res = await this.registeredHandlers[funcIndex](this.browser, this.page);
        if (res !== undefined && res !== null) {
          Object.assign(result, res);
        }
      } catch (err) {
        await this.registerError(new Error('Handler failed, func index: ' + funcIndex), "Handler_failed_" + funcIndex);
        await this.registerError(err, "Handler_failed_" + funcIndex);
      }
    }

    return result;
  }

  protected async test(): Promise<boolean> {
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
}
