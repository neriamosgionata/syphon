import Config from "@ioc:Adonis/Core/Config";
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
import Application from "@ioc:Adonis/Core/Application";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import Drive from "@ioc:Adonis/Core/Drive";
import path from "path";

export type LogChannels = keyof typeof logger.log_channels;

export interface LoggerContract {

  changeLogger(logChannelName: LogChannels, writeToConsole?: boolean): void;

  logger(logChannelName: LogChannels, writeToConsole?: boolean): LoggerContract;

  setPrintToConsole(status: boolean): LoggerContract;

  getCurrentChannelName(): LogChannels;

  debug(message: string, ...parameters: unknown[]): Promise<void>;

  info(message: string, ...parameters: unknown[]): Promise<void>;

  warn(message: string, ...parameters: unknown[]): Promise<void>;

  error(message: string, ...parameters: unknown[]): Promise<void>;

  fatal(message: string, ...parameters: unknown[]): Promise<void>;

  log(message: string, ...parameters: unknown[]): Promise<void>;

  table(table: any[], columnNames?: string[], logLevelTo?: LogLevelEnum): Promise<void>;

  tailLog(name: string, callbackTail: Function, callbackGet: Function): void;

  getCurrentLog(fileName?: string): Promise<{ logs: string[], name: string }>;

  getLogFileName(logFileLevel: LogLevelEnum): string;

  getAllAvailableLogs(): Promise<{ logs: string[] }>;

  deleteLog(name: string): Promise<void>;

  logFromThread(
    channel: LogChannels,
    message: string,
    parameters: any[],
    level?: LogLevelEnum,
    table?: any[],
    tableColumnNames?: string[],
    levelWriteTo?: LogLevelEnum,
  ): void;

  isDailyLogChannel(): boolean;

  getCurrentConfig(): { baseName: string, lifeTime: number, permissions: number, type: LogChannelEnum };
}

export default class Logger implements LoggerContract {
  private config: {
    baseName: string,
    lifeTime: number, //not implemented yet
    permissions: number,
    type: LogChannelEnum,
  };

  private readonly logFolder: string = "logs";

  private LOG_LEVEL_TO_FILE = {
    [LogLevelEnum.DEBUG]: "info",
    [LogLevelEnum.INFO]: "info",
    [LogLevelEnum.WARN]: "error",
    [LogLevelEnum.ERROR]: "error",
    [LogLevelEnum.FATAL]: "error"
  };

  private tailer!: any;

  private mainThreadLoggers: { [p: LogChannels]: LoggerContract } = {};

  constructor(
    private logChannelName: LogChannels = "daily",
    private writeToConsole: boolean = false,
  ) {
    this.writeToConsole = writeToConsole;

    if (logChannelName) {
      this.logChannelName = logChannelName.toString().toLowerCase();
      this.config = Config.get("app.logger.log_channels." + logChannelName.toString().toLowerCase());
    }

    if (!this.config || !logChannelName) {
      this.warn("Log channel used doesn't exist, reverting back to default")
        .then(() => {
        })
        .catch(() => {
        });
      this.logChannelName = "daily";
      this.config = Config.get("app.logger.log_channels.daily");
    }
  }

  changeLogger(logChannelName: LogChannels = "daily", writeToConsole: boolean = false) {
    Application.container.singleton(AppContainerAliasesEnum.Logger, () => this.logger(logChannelName, writeToConsole));

    this.writeToConsole = writeToConsole;

    if (logChannelName) {
      this.logChannelName = logChannelName.toString().toLowerCase();
      this.config = Config.get("app.logger.log_channels." + logChannelName.toString().toLowerCase());
    }

    if (!this.config || !logChannelName) {
      this.warn("Log channel used doesn't exist, reverting back to default")
        .then(() => {
        })
        .catch(() => {
        });
      this.logChannelName = "daily";
      this.config = Config.get("app.logger.log_channels.daily");
    }
  }

  logger(logChannelName: LogChannels = "daily", writeToConsole: boolean = false): LoggerContract {
    return new Logger(logChannelName, writeToConsole);
  }

  getCurrentChannelName(): LogChannels {
    return this.logChannelName;
  }

  debug(message: string, ...parameters: unknown[]): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, message, parameters, LogLevelEnum.DEBUG);
      return Promise.resolve();
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.DEBUG, logLine);
  }

  info(message: string, ...parameters: unknown[]): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, message, parameters, LogLevelEnum.INFO);
      return Promise.resolve();
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.INFO, logLine);
  }

  warn(message: string, ...parameters: unknown[]): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, message, parameters, LogLevelEnum.WARN);
      return Promise.resolve();
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.WARN, logLine);
  }

  error(message: string, ...parameters: unknown[]): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, message, parameters, LogLevelEnum.ERROR);
      return Promise.resolve();
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.ERROR, logLine);
  }

  fatal(message: string, ...parameters: unknown[]): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, message, parameters, LogLevelEnum.FATAL);
      return Promise.resolve();
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.FATAL, logLine);
  }

  log(message: string, ...parameters: unknown[]): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, message, parameters, LogLevelEnum.INFO);
      return Promise.resolve();
    }

    const logLine = this.attachParametersToMessage(message, parameters);
    return this.writeLine(LogLevelEnum.INFO, logLine);
  }

  table(table: any[], columnNames?: string[], logLevelTo: LogLevelEnum = LogLevelEnum.INFO): Promise<void> {
    if (!isMainThread) {
      logMessage(this.logChannelName, "", [], LogLevelEnum.TABLE, table, columnNames, logLevelTo);
      return Promise.resolve();
    }

    const logLine = this.createTableLog(table, columnNames);
    return this.writeLine(logLevelTo, logLine);
  }

  isDailyLogChannel(): boolean {
    return this.config.type === LogChannelEnum.DAILY;
  }

  getCurrentConfig(): { baseName: string, lifeTime: number, permissions: number, type: LogChannelEnum } {
    return this.config;
  }

  private retriveMainThreadLogger(channel: LogChannels): LoggerContract {
    return this.mainThreadLoggers[channel] || (this.mainThreadLoggers[channel] = this.logger(channel));
  }

  logFromThread(
    channel: LogChannels,
    message: string,
    parameters: any[],
    level: LogLevelEnum,
    table?: any[],
    tableColumnNames?: string[],
    levelWriteTo: LogLevelEnum = LogLevelEnum.INFO
  ): void {
    if (!isMainThread) {
      logMessage(
        channel,
        message,
        parameters,
        level,
        table,
        tableColumnNames,
        levelWriteTo
      );
      return;
    }

    const logger = this.retriveMainThreadLogger(channel);

    if (level === "table") {
      logger.table(table as any[], tableColumnNames, levelWriteTo)
        .then(() => {
        })
        .catch(() => {
        });
      return;
    }

    logger[level](message as string, ...(parameters || []));
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

  private async saveLog(logFileName: string, logLine: string): Promise<void> {
    try {
      await Drive.put(logFileName, logLine, {flag: 'a'});
    } catch (e) {
    }
  }

  private getTodayDate(): string {
    return moment().format("DD-MM-YYYY");
  }

  private getFullNowTime(): string {
    return moment().format("DD/MM/YYYY HH:mm:ss.SSSSSSSSS");
  }

  private writeLine(level: LogLevelEnum, logLine: string): Promise<void> {
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

    let logChannel: string | undefined;

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

    Drive.exists(logFileName)
      .then((exists) => {
        if (exists) {
          const config = this.retrieveConfigFromFileName(name);
          const logger = this.logger(config.logChannel);
          const computedFileName = logger.getLogFileName(config.logLevel);

          this.getCurrentLog(computedFileName)
            .then((data) => {
              callbackGet(data);

              const tailer = new Tail(path.resolve("storage/" + logFileName));

              tailer.on("line", (data: any) => {
                callbackTail(data);
              });

              tailer.on("error", (err: Error) => {
                this.error(err.message, err.stack)
                  .then(() => {
                  })
                  .catch(() => {
                  });
              });

              this.tailer = tailer;
            });

          return;
        }

        this.error("tailLog: Log file doesn't exist")
          .then(() => {
          })
          .catch(() => {
          });
      })
      .catch(() => {

      });
  }

  async getCurrentLog(fileName?: string): Promise<{ logs: string[], name: string }> {
    const logFileName = fileName || this.getLogFileName(LogLevelEnum.INFO);

    try {
      const exists = await Drive.exists(logFileName);

      if (exists) {
        return {
          logs: (await Drive.get(logFileName)).toString().split("\n").splice(-100),
          name: logFileName,
        };
      }

      this.error("getCurrentLog: Log file doesn't exist")
        .then(() => {
        })
        .catch(() => {
        });

      return {
        logs: [],
        name: logFileName,
      };
    } catch (e) {
      this.error("getCurrentLog: Log file doesn't exist", e)
        .then(() => {
        })
        .catch(() => {
        });

      return {
        logs: [],
        name: logFileName,
      };
    }
  }

  async getAllAvailableLogs(): Promise<{ logs: string[] }> {
    return {
      logs: (await Drive.list(this.logFolder).toArray())
        .filter((name) => name.location.includes(".log"))
        .map((name) => name.location.replace(this.logFolder + "/", "")),
    };
  }

  setPrintToConsole(status: boolean): LoggerContract {
    this.writeToConsole = status;
    return this;
  }

  async deleteLog(name: string): Promise<void> {
    await Drive.delete(this.logFolder + "/" + name);
  }
}
