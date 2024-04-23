import {JobList, JobListForFrontend} from "App/Jobs";
import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";
import {LogChannels} from "App/Services/Logger/Logger";

export type JobName = keyof typeof JobList;
export type JobNameForFrontend = typeof JobListForFrontend;

export type BaseJobParameters = {
  [p: string | number]: any
};

export type Callback = (message: JobMessage) => Promise<void> | void;
export type ErrorCallback = (error: Error, id: string, tags: string[]) => Promise<void> | void;

export interface JobMessage {
  status: JobMessageEnum;
  id: string;
  tags: string[];
  uuid?: string;
  payload?: any;
  error?: Error;
  logChannel?: LogChannels;
  logMessage?: string;
  logLevel?: LogLevelEnum;
  logParameters?: any[];
  logTable?: any[];
  logTableColumnNames?: string[];
  logLevelWriteTo?: LogLevelEnum;
}

export interface JobRunInfo {
  jobName: JobName;
  id: string;
  tags: string[];
  error?: Error;
}

export type JobWorkerData<T extends BaseJobParameters> = {
  [p in keyof T]: any;
} & {
  jobName: JobName;
  id: string;
  tags: string[];
  jobPath: string;
};
