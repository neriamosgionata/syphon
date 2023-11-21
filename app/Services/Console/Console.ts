import {isMainThread} from "node:worker_threads";
import {consoleLog} from "App/Services/Jobs/JobHelpers";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";

export interface ConsoleContract {
  log(...args: any[]): void;

  info(...args: any[]): void;

  warn(...args: any[]): void;

  error(...args: any[]): void;

  table(...args: any[]): void;

  debug(...args: any[]): void;

  fatal(...args: any[]): void;
}

export default class Console implements ConsoleContract {
  error(...args: any[]): void {
    if (isMainThread) {
      console.error(...args);
      return;
    }

    consoleLog(LogLevelEnum.ERROR, ...args);
  }

  info(...args: any[]): void {
    if (isMainThread) {
      console.info(...args);
      return;
    }

    consoleLog(LogLevelEnum.INFO, ...args);
  }

  log(...args: any[]): void {
    if (isMainThread) {
      console.log(...args);
      return;
    }

    consoleLog(LogLevelEnum.LOG, ...args);
  }

  table(...args: any[]): void {
    if (isMainThread) {
      console.table(...args);
      return;
    }

    consoleLog(LogLevelEnum.TABLE, ...args);
  }

  warn(...args: any[]): void {
    if (isMainThread) {
      console.warn(...args);
      return;
    }

    consoleLog(LogLevelEnum.WARN, ...args);
  }

  debug(...args: any[]): void {
    if (isMainThread) {
      console.debug(...args);
      return;
    }

    consoleLog(LogLevelEnum.DEBUG, ...args);
  }

  fatal(...args: any[]): void {
    if (isMainThread) {
      console.error(...args);
      return;
    }

    consoleLog(LogLevelEnum.ERROR, ...args);
  }
}
