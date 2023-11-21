import {Browser, CDPSession, executablePath, Page} from "puppeteer";
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

  getRunResult<T>(): ScraperRunReturn<T>;

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): BaseScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): BaseScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): BaseScraperContract;

  setRemoveUserDataOnExit(removeUserDataOnExit: boolean): BaseScraperContract;

  setLoggerChannel(logChannel: string, writeOnConsole: boolean): BaseScraperContract;

  setPrintInConsole(writeOnConsole: boolean): BaseScraperContract;

  setDebugConsole(debugConsole: boolean): BaseScraperContract;

  setTests(testsFunctions: ScraperTestFunction[]): BaseScraperContract;

  setHandlers(handlersFunctions: ScraperHandlerFunction<any>[]): BaseScraperContract;

  setScraperStatusName(name: string): BaseScraperContract;

  resetScraperStatus(): Promise<void>;

  updateScraperStatus(status: object | any): Promise<void>;

  registerError(error: Error | any, key: string): Promise<void>;

  writeTableLog(table: any[]): void;

  writeLog(level: string, message: string, ...values: unknown[]): void;
}

export default class BaseScraper implements BaseScraperContract {
  protected defaultStatus: { name: string, status: { [p: string | number]: any } } = {name: "", status: {}};
  protected scraperStatus: typeof this.defaultStatus = this.defaultStatus;

  protected errors: Error[] = [];
  protected results: any = {};

  protected browser!: Browser;

  protected page!: Page;
  protected cdpClient!: CDPSession;

  protected extraOpenedPages: Page[] = [];
  protected extraCdpClient!: CDPSession[];

  protected registeredTests: ScraperTestFunction[] = [];
  protected registeredHandlers: ScraperHandlerFunction<any>[] = [];
  protected logger: LoggerContract;

  constructor(
    protected withHeadlessChrome: boolean | string = true,
    protected writeOnConsole: boolean = false,
    protected debugConsole: boolean = false,
    protected withAdblockerPlugin: boolean = false,
    protected withStealthPlugin: boolean = false,
    protected removeUserDataOnExit: boolean = true,
    protected logChannel: string = "scraper",
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

  setRemoveUserDataOnExit(removeUserDataOnExit: boolean): this {
    this.removeUserDataOnExit = removeUserDataOnExit;
    return this;
  }

  setPrintInConsole(writeOnConsole: boolean): this {
    this.writeOnConsole = writeOnConsole;
    return this;
  }

  setDebugConsole(debugConsole: boolean): this {
    this.debugConsole = debugConsole;
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

  private getErrors(): Error[] {
    return this.errors;
  }

  private getResults<T>(): T {
    return this.results as T;
  }

  getRunResult<T>(): ScraperRunReturn<T> {
    return {results: this.getResults<T>(), errors: this.getErrors()};
  }

  //HANDLER

  async run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>> {
    try {

      await this.start();

    } catch (e) {

      await this.registerError(e, "Start");

      await this.end();

      return this.getRunResult<T>();
    }

    try {

      const isOk = await this.test();

      if (!isOk) {

        await this.registerError(new Error('Initial test was not successful!'), "Tests");

        await this.end();

        return this.getRunResult<T>();

      }

    } catch (e) {

      await this.registerError(e, "Test");

      await this.end();

      return this.getRunResult<T>();
    }

    try {

      await this.handle();

      await this.end();

    } catch (err) {

      await this.registerError(err, "Execution");

    }

    return this.getRunResult<T>();
  }

  async openNewPage(): Promise<Page> {
    const page = await this.browser.newPage();

    if (this.writeOnConsole && this.debugConsole) {
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
    this.extraCdpClient.push(await page.target().createCDPSession());

    return page;
  }

  protected async start() {
    await this.runPuppeteer();
  }

  protected async runPuppeteer(): Promise<void> {
    this.results = {};
    this.errors = [];

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
      "--lang=\"en-US\"",
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
    this.cdpClient = await this.page.target().createCDPSession();

    if (this.writeOnConsole && this.debugConsole) {
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

  protected async end(): Promise<void> {
    if (this.page && this.page.close && !this.page.isClosed()) {

      if (this.removeUserDataOnExit) {
        await this.cdpClient.send('Network.clearBrowserCookies');
        await this.cdpClient.send('Network.clearBrowserCache');
      }

      await this.cdpClient.detach();
      await this.page.close();
    }

    for (const pageIndex in this.extraOpenedPages) {
      const page = this.extraOpenedPages[pageIndex];
      const cdpClient = this.extraCdpClient[pageIndex];

      if (this.removeUserDataOnExit) {
        await cdpClient.send('Network.clearBrowserCookies');
        await cdpClient.send('Network.clearBrowserCache');
      }

      await cdpClient.detach();

      if (page && page.close && !page.isClosed()) {
        await page.close();
      }
    }

    if (this.browser && this.browser.close && this.browser.connected) {
      await this.browser.close();
    }

    if (this.errors.length > 0) {
      this.writeLog('error', 'Errors during execution: \n\r');
      this.writeTableLog(this.errors);
    }

    this.registeredHandlers = [];
    this.registeredTests = [];
    this.extraCdpClient = [];
    this.extraOpenedPages = [];
  }

  protected async handle(): Promise<void> {
    let result = {} as any;

    for (const funcIndex in this.registeredHandlers) {
      try {
        const res = await this.registeredHandlers[funcIndex](this.browser, this.page);
        if (res) {
          result = {...res};
        }
      } catch (err) {
        await this.registerError(new Error('Handler failed, func index: ' + funcIndex), "Handler_failed_" + funcIndex);
        await this.registerError(err, "Handler_failed_" + funcIndex);
        break;
      }
    }

    this.results = result;
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
