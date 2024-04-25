import {Browser, CDPSession, executablePath, Page} from "puppeteer";
import {LogChannels, LoggerContract} from "App/Services/Logger/Logger";
import Log from "@ioc:Providers/Logger";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";
import Env from "@ioc:Adonis/Core/Env";
import * as uuid from "uuid";
import Console from "@ioc:Providers/Console";
import Drive from "@ioc:Adonis/Core/Drive";

export type ScraperTestFunction = (_browser: Browser, _page: Page) => Promise<boolean>;

export type ScraperHandlerReturn<T extends ({ [p: string | number]: any } | null | undefined)> = T;

export type ScraperHandlerFunction<T extends ScraperHandlerReturn<any>> = (
  _browser: Browser,
  _page: Page,
  args: { [p: string]: any },
  results: { [p: string]: any },
) => Promise<T>;

export type ScraperRunReturn<T extends ScraperHandlerReturn<any>> = { results: T, errors: Error[] };

export interface BaseScraperContract {
  end(): Promise<void>;

  run<T extends ScraperHandlerReturn<any>>(): Promise<ScraperRunReturn<T>>;

  openNewPage(): Promise<Page>;

  getRunResult<T>(): ScraperRunReturn<T>;

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean | string): BaseScraperContract;

  setWithStealthPlugin(withStealthPlugin: boolean): BaseScraperContract;

  setWithAdblockerPlugin(withAdblockerPlugin: boolean): BaseScraperContract;

  setRemoveUserDataOnExit(removeUserDataOnExit: boolean): BaseScraperContract;

  setLoggerChannel(logChannel: LogChannels, writeOnConsole: boolean): BaseScraperContract;

  setPrintInConsole(writeOnConsole: boolean): BaseScraperContract;

  setDebugConsole(debugConsole: boolean): BaseScraperContract;

  setTakeScreenshot(takeScreenshot: boolean): BaseScraperContract;

  setTests(testsFunctions: ScraperTestFunction[]): BaseScraperContract;

  setHandlers(handlersFunctions: ScraperHandlerFunction<any>[]): BaseScraperContract;

  setArguments(args: { [p: string]: any }): BaseScraperContract;

  setCloseOnExit(closeOnExit: boolean): BaseScraperContract;

  setEnableProxy(enableProxy: boolean): BaseScraperContract;

  addHandler(handlerFunction: ScraperHandlerFunction<any>): BaseScraperContract;

  addEventListener(event: string, callback: (args: {
    type: string,
    pageIndex: number,
    event: Event
  }) => void): BaseScraperContract;

  setEventListeners(events: {
    event: string,
    callback: (args: { type: string, pageIndex: number, event: Event }) => void
  }[]): BaseScraperContract;

  registerError(error: Error | any, key: string): void;

  writeTableLog(table: any[], logLevel?: LogLevelEnum): Promise<void>;

  writeLog(level: string, message: string, ...values: unknown[]): Promise<void>;

  getIsHeadless(): boolean;

  sendEvent(_originalPage: Page, progressEventName: string): Promise<void>;
}

export default class BaseScraper implements BaseScraperContract {
  protected errors: Error[] = [];
  protected results: any = {};

  protected browser!: Browser;

  protected page!: Page;
  protected cdpClient!: CDPSession;

  protected extraOpenedPages: Page[] = [];
  protected extraCdpClient!: CDPSession[];

  protected registeredTests: ScraperTestFunction[] = [];
  protected registeredHandlers: ScraperHandlerFunction<any>[] = [];
  protected registeredListeners: {
    event: string,
    callback: (args: { type: string, pageIndex: number, event: Event }) => void
  }[] = [];
  protected logger: LoggerContract;
  protected args: { [p: string]: any } = {};

  protected enableTakeScreenshot: boolean = false;
  protected closeOnExit: boolean = true;

  protected isRunning: boolean = false;

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
    this.logger = Log.logger(logChannel, writeOnConsole);
  }

  // SETUP

  setWithHeadlessChrome(headlessChrome: boolean): this {
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

  setLoggerChannel(logChannel: LogChannels, writeOnConsole: boolean = false): this {
    this.logger = Log.logger(logChannel, writeOnConsole);
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

  setArguments(args: { [p: string]: any }): this {
    this.args = args;
    return this;
  }

  setCloseOnExit(closeOnExit: boolean): this {
    this.closeOnExit = closeOnExit;
    return this;
  }

  setEnableProxy(enableProxy: boolean): this {
    this.enableProxy = enableProxy;
    return this;
  }

  addHandler(handlerFunction: ScraperHandlerFunction<any>): this {
    this.registeredHandlers.push(handlerFunction);
    return this;
  }

  addEventListener(event: string, callback: (args: { type: string, pageIndex: number, event: Event }) => void): this {
    this.registeredListeners.push({event, callback});
    return this;
  }

  setEventListeners(events: {
    event: string,
    callback: (args: { type: string, pageIndex: number, event: Event }) => void
  }[]): this {
    this.registeredListeners = events;
    return this;
  }

  setTakeScreenshot(takeScreenshot: boolean): this {
    this.enableTakeScreenshot = takeScreenshot;
    return this;
  }

  getIsHeadless(): boolean {
    return this.withHeadlessChrome;
  }

  registerError(error: Error | any, key: string): void {
    const newErr = new Error(key + ": " + error.message);
    newErr.stack = error.stack;
    this.errors.push(error);
  }

  async writeTableLog(table: any[], logLevel: LogLevelEnum = LogLevelEnum.INFO): Promise<void> {
    await this.logger.table(table, [], logLevel);
  }

  async writeLog(level: LogLevelEnum, message: string, ...values: unknown[]): Promise<void> {
    await this.logger[level.trim()](message, ...values);
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
    this.isRunning = true;

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

    await this.handle();

    await this.end();

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

    await this.addEventListenersToPage(page, this.extraOpenedPages.length - 1);

    return page;
  }

  protected async start() {
    await this.runPuppeteer();
  }

  protected async runPuppeteer(): Promise<void> {
    this.results = {};
    this.errors = [];

    const args = [
      "--single-process",
      "--allow-running-insecure-content",
      "--autoplay-policy=user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-ipc-flooding-protection",
      "--disable-print-preview",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--disable-site-isolation-trials",
      "--disable-speech-api",
      "--disable-web-security",
      "--disk-cache-size=1073741824",
      "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process",
      "--enable-features=SharedArrayBuffer,NetworkService,NetworkServiceInProcess",
      "--hide-scrollbars",
      "--ignore-gpu-blocklist",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-pings",
      "--no-sandbox",
      "--no-zygote",
      "--window-size=1920,1080",
      "--ignore-certificate-errors",
      "--enable-automation",
      "--no-default-browser-check",
      "--in-process-gpu",
    ];

    if (this.enableProxy && Env.get("USE_PROXY", false)) {
      args.filter((arg) => !arg.includes("--proxy-server="));
      const proxyAddress = Env.get("NODE_ENV") === "development" ? "localhost" : "proxy";
      const proxyArgs = `--proxy-server=http=${proxyAddress}:${Env.get("LOCAL_PROXY_PORT", 6001)}`;
      args.push(proxyArgs);
    }

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
      protocolTimeout: 60000,
    };

    const puppeteer = (await import("puppeteer-extra")).default;

    if (this.withStealthPlugin) {
      const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
      puppeteer.use(StealthPlugin());
    }

    if (this.withAdblockerPlugin) {
      const AdBlockerPlugin = (await import("puppeteer-extra-plugin-adblocker")).default;
      puppeteer.use(AdBlockerPlugin({
        blockTrackers: true,
        blockTrackersAndAnnoyances: true,
      }));
    }

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

    await this.addEventListenersToPage(this.page, 0);
  }

  async end(): Promise<void> {
    if (this.isRunning) {
      this.isRunning = false;

      await this.captureScreenshot();

      if (this.closeOnExit) {
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
      }

      if (this.errors.length > 0) {
        await this.writeLog(LogLevelEnum.ERROR, "Errors during execution:");

        const errorTable: any = this.errors.reduce((acc, error) => {
          acc.push(
            [
              error.message,
              error.stack,
            ]
          );
          return acc;
        }, [] as any[]);

        await this.writeTableLog(
          errorTable,
          LogLevelEnum.ERROR,
        );
      }

      this.registeredHandlers = [];
      this.registeredTests = [];
      this.extraCdpClient = [];
      this.extraOpenedPages = [];
    }
  }

  protected async handle(): Promise<void> {
    let result = {} as any;

    for (const funcIndex in this.registeredHandlers) {
      try {
        const res = await this.registeredHandlers[funcIndex](this.browser, this.page, this.args, result);
        if (res) {
          result = {...result, ...res};
        }
      } catch (err) {
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

  protected async captureScreenshot(name?: string): Promise<void> {
    if (this.enableTakeScreenshot) {
      const folder = Date.now();

      let fileName = (name || (uuid.v4() + "_" + Date.now())) + ".png";

      await Drive.put(`screenshots/${folder}/${fileName}`, "");

      await this.page.screenshot({
        path: `screenshots/${folder}/${fileName}`,
        captureBeyondViewport: true,
        fullPage: true,
      });

      for (const page of this.extraOpenedPages) {
        fileName = (name || (uuid.v4() + "_" + Date.now())) + ".png";

        await Drive.put(`screenshots/${folder}/${fileName}`, "");

        await page.screenshot({
          path: `screenshots/${folder}/${fileName}`,
          captureBeyondViewport: true,
          fullPage: true,
        });
      }
    }
  }

  protected async addEventListenersToPage(page: Page, pageIndex: number): Promise<void> {
    for (const listener of this.registeredListeners) {
      await page.exposeFunction(listener.event, (args) => {
        listener.callback({...args, pageIndex});
      });

      await page.evaluateOnNewDocument((type) => {
        window.addEventListener(
          type,
          (e) => {
            window[type]({type, event: e});
          },
        );
      }, listener.event);
    }
  }

  async sendEvent(_originalPage: Page, progressEventName: string): Promise<void> {
    await _originalPage.evaluate((e) => {
      window.dispatchEvent(new Event(e));
    }, progressEventName);
  }
}
