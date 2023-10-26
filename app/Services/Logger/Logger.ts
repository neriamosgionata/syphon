import Config from "@ioc:Adonis/Core/Config";
import fs from "fs";
import moment from "moment";
import {LogChannelEnum} from "App/Enums/LogChannelEnum";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";

export interface LoggerContract {
  removeOneTimeLog(): void;

  channel(channelName: string): LoggerContract;

  setPrintToConsole(status: boolean): LoggerContract;

  getCurrentChannelName(): string;

  debug(message: string, ...values: unknown[]): true | Error;

  info(message: string, ...values: unknown[]): true | Error;

  warn(message: string, ...values: unknown[]): true | Error;

  error(message: string, ...values: unknown[]): true | Error;

  fatal(message: string, ...values: unknown[]): true | Error;

  table(table: any[]): true | Error;
}

export default class Logger implements LoggerContract {
  private config: {
    baseName: string,
    lifeTime: number, //not implemented yet
    permissions: number,
    type: LogChannelEnum,
  } = Config.get("app.logger.log_channels.default");

  private logFolder: string = Config.get("app.logger.log_folder");
  private channelName = "default";

  private LOG_LEVEL_TO_FILE = {
    [LogLevelEnum.DEBUG]: "info",
    [LogLevelEnum.INFO]: "info",
    [LogLevelEnum.WARN]: "error",
    [LogLevelEnum.ERROR]: "error",
    [LogLevelEnum.FATAL]: "error"
  };

  private printToConsole: boolean = false;

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

  //This methods changes the singleton configuration
  // @ts-ignore
  channel(channelName: string = "default"): this {
    this.config = Config.get("app.logger.log_channels." + channelName);

    if (channelName !== this.channelName) {
      this.removeOneTimeLog();
    }

    this.channelName = channelName;

    if (!this.config) {
      this.config = Config.get("app.logger.log_channels.default");
      this.channelName = "default";
      this.warn("Log channel used doesn't exist, reverting back to default");
    }

    return this;
  }

  getCurrentChannelName(): string {
    return this.channelName;
  }

  debug(message: string, ...values: unknown[]): true | Error {
    const logLine = this.attachParametersToMessage(message, values);
    return this.writeLine(LogLevelEnum.DEBUG, logLine);
  }

  info(message: string, ...values: unknown[]): true | Error {
    const logLine = this.attachParametersToMessage(message, values);
    return this.writeLine(LogLevelEnum.INFO, logLine);
  }

  warn(message: string, ...values: unknown[]): true | Error {
    const logLine = this.attachParametersToMessage(message, values);
    return this.writeLine(LogLevelEnum.WARN, logLine);
  }

  error(message: string, ...values: unknown[]): true | Error {
    const logLine = this.attachParametersToMessage(message, values);
    return this.writeLine(LogLevelEnum.ERROR, logLine);
  }

  fatal(message: string, ...values: unknown[]): true | Error {
    const logLine = this.attachParametersToMessage(message, values);
    return this.writeLine(LogLevelEnum.FATAL, logLine);
  }

  table(table: any[]): true | Error {
    const logLine = this.createTableLog(table);
    return this.writeLine(LogLevelEnum.INFO, logLine);
  }

  private getLogLineAnnotation(): string {
    const fullTime = this.getFullNowTime();
    return "[" + fullTime + "]";
  }

  private getLogLine(level: string, logLine: string): string {
    return this.getLogLineAnnotation() + "[" + level.toUpperCase() + "] " + logLine + "\t\n";
  }

  private getLogFileName(logFileLevel: LogLevelEnum) {
    let logFileName = this.config.baseName || "adonis";

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
      console.log(logLineWithAnnotation);
    }
    return this.saveLog(logFileName, logLineWithAnnotation);
  }

  private attachParametersToMessage(message: string, values: unknown[]): string {
    let logLine = message;
    if (values.length) {
      logLine += ", parameters: " + JSON.stringify(values);
    }
    return logLine;
  }

  private createTableLog(table: any[]) {
    let logLine = "";

    const columnNames: string[] = [];
    const columns: any[][] = [];
    const anyColumn: any[] = [];

    table.forEach((element) => {
      if (typeof element === "object") {
        Object.entries(element).forEach((keyValue) => {
          let index = columnNames.indexOf(keyValue[0]);

          if (!columns[index]) {
            columns[index] = [];
          }

          if (index > -1) {
            columns[index].push(keyValue[1]);
            return;
          }

          index = columnNames.push(keyValue[0]) - 1;
          columns[index].push(keyValue[1]);
        });

        return;
      }

      anyColumn.push(element);
      return;
    });


    if (columns.length) {
      const cnLength = columnNames.length;

      let maxColumnLength = 0;

      columns.forEach((column) => {
        maxColumnLength = column.length > maxColumnLength ? column.length : maxColumnLength;
      });

      logLine += "|" + ("---------".repeat(cnLength)) + "| \n";
      logLine += "|";

      columnNames.forEach((element) => {
        logLine += element + " | ";
      });

      logLine += " \n";

      columnNames.forEach((_element, index) => {
        logLine += "|";
        for (let i = 0; i < maxColumnLength; i++) {
          logLine += (columns[index][i] || " ") + " | ";
        }
      });

      logLine += " \n \n \n ";
    }

    if (anyColumn.length) {
      logLine += "|----------------------------------| \n";
      logLine += "|";

      anyColumn.forEach((element) => {
        logLine += element + " | ";
      });

      logLine += " \n";
    }

    return logLine;
  }

  setPrintToConsole(status: boolean): LoggerContract {
    this.printToConsole = status;
    return this;
  }
}
