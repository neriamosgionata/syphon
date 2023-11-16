import {isMainThread} from "node:worker_threads";
import {consoleLog} from "App/Services/Jobs/JobHelpers";

export interface ConsoleContract {
  log(...args: any[]): void;

  info(...args: any[]): void;

  warn(...args: any[]): void;

  error(...args: any[]): void;

  table(...args: any[]): void;
}

export default class Console implements ConsoleContract {
  error(...args: any[]): void {
    if (isMainThread) {
      console.error(...args);
      return;
    }

    consoleLog("error", ...args);
  }

  info(...args: any[]): void {
    if (isMainThread) {
      console.info(...args);
      return;
    }

    consoleLog("info", ...args);
  }

  log(...args: any[]): void {
    if (isMainThread) {
      console.log(...args);
      return;
    }

    consoleLog("log", ...args);
  }

  table(...args: any[]): void {
    if (isMainThread) {
      console.table(...args);
      return;
    }

    consoleLog("table", ...args);
  }

  warn(...args: any[]): void {
    if (isMainThread) {
      console.warn(...args);
      return;
    }

    consoleLog("warn", ...args);
  }
}
