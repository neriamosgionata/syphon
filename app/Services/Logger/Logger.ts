import Config from "@ioc:Adonis/Core/Config";
import fs from "fs";
import moment from "moment";
import {LogChannelEnum} from "App/Enums/LogChannelEnum";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";
import {logMessage} from "App/Services/Jobs/JobHelpers";
import {isMainThread} from "node:worker_threads";
import Console from "@ioc:Providers/Console";
import {table as T} from "table";
import {logger} from "Config/app";
import {Tail} from "tail";
import Helper from "@ioc:Providers/Helper";

export type LogChannels = keyof typeof logger.log_channels;

export interface LoggerContract {
  removeOneTimeLog(): void;

  changeLogger(logChannelName: LogChannels, writeToConsole?: boolean): void;

  logger(logChannelName: LogChannels, writeToConsole?: boolean): LoggerContract;

  setPrintToConsole(status: boolean): LoggerContract;

  getCurrentChannelName(): LogChannels;

  debug(message: string, ...parameters: unknown[]): true | Error;

  info(message: string, ...parameters: unknown[]): true | Error;

  warn(message: string, ...parameters: unknown[]): true | Error;

  error(message: string, ...parameters: unknown[]): true | Error;

  fatal(message: string, ...parameters: unknown[]): true | Error;

  log(message: string, ...parameters: unknown[]): true | Error;

  table(table: any[], columnNames?: string[], logLevelTo?: LogLevelEnum): true | Error;

  tailLog(name: string, callbackTail: Function, callbackGet: Function): void;

  getCurrentLog(fileName?: string): { logs: string[], name: string };

  getLogFileName(logFileLevel: LogLevelEnum): string;

  getAllAvailableLogs(): { logs: string[] };

  deleteLog(name: string): void;
}

export default class Logger implements LoggerContract {
  private config: {
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

  private tailer!: any;

  constructor(
    private logChannelName: LogChannels = "daily",
    private writeToConsole: boolean = false,
  ) {
    this.logFolder = Config.get("app.logger.log_folder");
    this.writeToConsole = writeToConsole;

    if (logChannelName) {
      this.logChannelName = logChannelName.toString().toLowerCase();
      this.config = Config.get("app.logger.log_channels." + logChannelName.toString().toLowerCase());
    }

    if (!this.config || !logChannelName) {
      this.warn("Log channel used doesn't exist, reverting back to default");
      this.logChannelName = "daily";
      this.config = Config.get("app.logger.log_channels.daily");
    }

    this.removeOneTimeLog();
  }

  changeLogger(logChannelName: LogChannels = "daily", writeToConsole: boolean = false) {
    this.writeToConsole = writeToConsole;

    if (logChannelName) {
      this.logChannelName = logChannelName.toString().toLowerCase();
      this.config = Config.get("app.logger.log_channels." + logChannelName.toString().toLowerCase());
    }

    if (!this.config || !logChannelName) {
      this.warn("Log channel doesn't exist, reverting back to daily");
      this.logChannelName = "daily";
      this.config = Config.get("app.logger.log_channels.daily");
    }

    this.removeOneTimeLog();
  }

  logger(logChannelName: LogChannels = "daily", writeToConsole: boolean = false): LoggerContract {
    return new Logger(logChannelName, writeToConsole);
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

  getCurrentChannelName(): LogChannels {
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

  getLogFileName(logFileLevel: LogLevelEnum) {
    let logFileName = this.config.baseName || "adonis";

    switch (this.config.type) {
      case LogChannelEnum.DAILY:
        logFileName += "-date-" + this.getTodayDate();
        break;
      case LogChannelEnum.STACK:
        break;
      case LogChannelEnum.ONETIME:
        break;
      default:
        logFileName += "-" + this.getTodayDate();
        break;
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

    if (this.writeToConsole) {
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

    return table.length > 0 ? ("\n" + T(table)) : "";
  }

  retrieveConfigFromFileName(name: string): { logPrefix: string, logLevel: LogLevelEnum, logChannel: LogChannels } {
    name = name.replace(this.logFolder + "/", "").replace(".log", "");

    const namesplit = name.split("-");

    namesplit.shift();

    const logLevel = namesplit.pop();

    const nametemp = namesplit.join("-").split("-date-");

    let logChannel: string | undefined = "";

    if (nametemp.length > 1) {
      logChannel = nametemp.shift();
    } else {
      logChannel = nametemp[0];
    }

    return {
      logPrefix: "adonis",
      logLevel: (!logLevel || Helper.isNumeric(logLevel)) ? LogLevelEnum.INFO : logLevel as LogLevelEnum,
      logChannel: (!logChannel || Helper.isNumeric(logChannel) || Helper.isDate(logChannel)) ? "daily" : logChannel as LogChannels,
    };
  }

  tailLog(name: string, callbackTail: Function, callbackGet: Function): void {
    if (this.tailer) {
      this.tailer.unwatch();
    }

    const logFileName = this.logFolder + "/" + name;

    if (fs.existsSync(logFileName)) {
      const config = this.retrieveConfigFromFileName(name);
      const logger = this.logger(config.logChannel);
      const computedFileName = logger.getLogFileName(config.logLevel);
      callbackGet(this.getCurrentLog(computedFileName));

      const tailer = new Tail(logFileName);
      tailer.on("line", (data) => {
        callbackTail(data);
      });
      tailer.on("error", (err) => {
        this.error(err.message, err.stack);
      });
      this.tailer = tailer;

      return;
    }

    this.error("tailLog: Log file doesn't exist");
  }

  getCurrentLog(fileName?: string): { logs: string[], name: string } {
    const logFileName = fileName || this.getLogFileName(LogLevelEnum.INFO);

    if (fs.existsSync(logFileName)) {
      return {
        logs: fs.readFileSync(logFileName).toString().split("\n").splice(-100),
        name: logFileName,
      };
    }

    this.error("getCurrentLog: Log file doesn't exist");

    return {
      logs: [],
      name: logFileName,
    };
  }

  getAllAvailableLogs(): { logs: string[] } {
    return {
      logs: fs.readdirSync(this.logFolder)
        .filter((name) => name.endsWith(".log"))
        .map((name) => {
          return name.replace(this.logFolder + "/", "");
        }),
    };
  }

  setPrintToConsole(status: boolean): LoggerContract {
    this.writeToConsole = status;
    return this;
  }

  deleteLog(name: string): void {
    const logFileName = this.logFolder + "/" + name;

    if (fs.existsSync(logFileName)) {
      fs.rmSync(logFileName);
    }
  }
}
