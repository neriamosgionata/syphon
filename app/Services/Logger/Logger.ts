import Config from "@ioc:Adonis/Core/Config";
import fs from "fs";
import moment from "moment";
import {LogChannelEnum} from "App/Enums/LogChannelEnum";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";
import Application from "@ioc:Adonis/Core/Application";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {logMessage} from "App/Services/Jobs/JobHelpers";
import {isMainThread} from "node:worker_threads";
import Console from "@ioc:Providers/Console";
import {table as T} from "table";

export interface LoggerContract {
  removeOneTimeLog(): void;

  changeAppDefaultLogger(
    logChannelName: string,
    logPrefix: string,
    printToConsole: boolean,
  ): void;

  logger(
    logChannelName: string,
    logPrefix: string,
    printToConsole: boolean,
  ): LoggerContract;

  setPrintToConsole(status: boolean): LoggerContract;

  getCurrentChannelName(): string;

  debug(message: string, ...parameters: unknown[]): true | Error;

  info(message: string, ...parameters: unknown[]): true | Error;

  warn(message: string, ...parameters: unknown[]): true | Error;

  error(message: string, ...parameters: unknown[]): true | Error;

  fatal(message: string, ...parameters: unknown[]): true | Error;

  log(message: string, ...parameters: unknown[]): true | Error;

  table(table: any[], columnNames?: string[], logLevelTo?: LogLevelEnum): true | Error;
}

export default class Logger implements LoggerContract {
  private readonly config: {
    baseName: string,
    lifeTime: number, //not implemented yet
    permissions: number,
    type: LogChannelEnum,
  };

  private readonly logFolder: string;

  private LOG_LEVEL_TO_FILE = {
    [LogLevelEnum.DEBUG]: "info",
    [LogLevelEnum.INFO]: "info",
    [LogLevelEnum.WARN]: "error",
    [LogLevelEnum.ERROR]: "error",
    [LogLevelEnum.FATAL]: "error"
  };

  constructor(
    private readonly logChannelName: string = "default",
    private readonly logPrefix: string = "adonis",
    private printToConsole: boolean = false,
  ) {
    this.logFolder = Config.get("app.logger.log_folder");
    this.printToConsole = printToConsole;
    this.logPrefix = logPrefix;

    if (logChannelName) {
      this.logChannelName = logChannelName;
      this.config = Config.get("app.logger.log_channels." + logChannelName);
      if (!this.config) {
        this.warn("Log channel used doesn't exist, reverting back to default");
      }
    }

    if (!this.config || !logChannelName) {
      this.logChannelName = "default";
      this.config = Config.get("app.logger.log_channels.default");
    }
  }

  changeAppDefaultLogger(
    logChannelName: string = "default",
    logPrefix: string = "",
    printToConsole: boolean,
  ) {
    Application.container.singleton(AppContainerAliasesEnum.Logger, () => {
      return this.logger(logChannelName, logPrefix, printToConsole);
    });
  }

  removeOneTimeLog(): void {
    if (this.config.type === LogChannelEnum.ONETIME) {
      const logFileNameInfo = this.getLogFileName(LogLevelEnum.INFO);

      if (fs.existsSync(logFileNameInfo)) {
        fs.rmSync(logFileNameInfo);
      }

      const logFileNameError = this.getLogFileName(LogLevelEnum.ERROR);

      if (fs.existsSync(logFileNameError)) {
        fs.rmSync(logFileNameError);
      }
    }
  }

  logger(
    logChannelName: string = "default",
    logPrefix: string = "",
    printToConsole: boolean = false,
  ): LoggerContract {
    return new Logger(logChannelName, logPrefix, printToConsole);
  }

  getCurrentChannelName(): string {
    return this.logChannelName;
  }

  debug(message: string, ...parameters: unknown[]): true | Error {
    if (!isMainThread) {
      logMessage(message, parameters, LogLevelEnum.DEBUG);
      return true;
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.DEBUG, logLine);
  }

  info(message: string, ...parameters: unknown[]): true | Error {
    if (!isMainThread) {
      logMessage(message, parameters, LogLevelEnum.INFO);
      return true;
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.INFO, logLine);
  }

  warn(message: string, ...parameters: unknown[]): true | Error {
    if (!isMainThread) {
      logMessage(message, parameters, LogLevelEnum.WARN);
      return true;
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.WARN, logLine);
  }

  error(message: string, ...parameters: unknown[]): true | Error {
    if (!isMainThread) {
      logMessage(message, parameters, LogLevelEnum.ERROR);
      return true;
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.ERROR, logLine);
  }

  fatal(message: string, ...parameters: unknown[]): true | Error {
    if (!isMainThread) {
      logMessage(message, parameters, LogLevelEnum.FATAL);
      return true;
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.FATAL, logLine);
  }

  log(message: string, ...parameters: unknown[]): true | Error {
    if (!isMainThread) {
      logMessage(message, parameters, LogLevelEnum.INFO);
      return true;
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.INFO, logLine);
  }

  table(table: any[], columnNames: string[] = [], logLevelTo: LogLevelEnum = LogLevelEnum.INFO): true | Error {
    if (!isMainThread) {
      logMessage("", [], LogLevelEnum.TABLE, table, columnNames, logLevelTo);
      return true;
    }

    const logLine = this.createTableLog(table, columnNames);
    return this.writeLine(logLevelTo, logLine);
  }

  private getLogLineAnnotation(): string {
    const fullTime = this.getFullNowTime();
    return "[" + fullTime + "]";
  }

  private getLogLine(level: LogLevelEnum, logLine: string): string {
    return this.getLogLineAnnotation() + "[" + level.toUpperCase() + "] " + logLine + "\t\n";
  }

  private getLogFileName(logFileLevel: LogLevelEnum) {
    let logFileName = this.logPrefix || this.config.baseName || "adonis";

    switch (this.config.type) {
      case LogChannelEnum.DAILY:
        logFileName += "-" + this.getTodayDate();
        break;
      case LogChannelEnum.STACK:
        break;
      case LogChannelEnum.ONETIME:
        break;
      default:
        throw new Error("Wrong log channel type");
    }

    return this.logFolder + "/" + logFileName + "-" + this.LOG_LEVEL_TO_FILE[logFileLevel] + ".log";
  }

  private saveLog(logFileName: string, logLine: string): true | Error {
    try {
      fs.appendFileSync(logFileName, logLine);
      return true;
    } catch (e) {
      return e;
    }
  }

  private getTodayDate(): string {
    return moment().format("DD-MM-YYYY");
  }

  private getFullNowTime(): string {
    return moment().format("DD/MM/YYYY HH:mm:ss");
  }

  private writeLine(level: LogLevelEnum, logLine: string): true | Error {

    const logFileName = this.getLogFileName(level);
    const logLineWithAnnotation = this.getLogLine(level, logLine);

    if (this.printToConsole) {
      Console.log(logLineWithAnnotation);
    }

    return this.saveLog(logFileName, logLineWithAnnotation);
  }

  private attachParametersToMessage(message: string, parameters?: unknown[]): string {
    let logLine = "" + message;
    if (parameters?.length) {
      parameters = parameters.filter((value) => value !== undefined && value !== null);
      logLine += " - parameters: " + JSON.stringify(parameters);
    }
    return logLine;
  }

  private createTableLog(table: any[], columnNames: string[] = []): string {
    if (columnNames.length) {
      table.unshift(columnNames);
    }

    table = table.map((row) => {
      if (typeof row === "object" && row instanceof Date) {
        return [row.toISOString()];
      }

      if (typeof row === "object" && !Array.isArray(row)) {
        return Object.values(row);
      }

      if (Array.isArray(row)) {
        return row;
      }

      return [row];
    });

    return T(table);
  }

  setPrintToConsole(status: boolean): LoggerContract {
    this.printToConsole = status;
    return this;
  }
}
