import {JobStatusEnum} from "App/Enums/JobStatusEnum";
import fs from "fs";
import Job from "App/Models/Job";
import Application from "@ioc:Adonis/Core/Application";
import Logger from "@ioc:Providers/Logger";
import {Worker} from "worker_threads";
import path from "path";
import {toLuxon} from "@adonisjs/validator/build/src/Validations/date/helpers/toLuxon";
import Config from "@ioc:Adonis/Core/Config";

export interface JobContract {
  dispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags?: string[],
    callback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void
  ): Promise<{ id: string, tags: string[] }>;

  runWithoutDispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags?: string[],
    callback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void,
    id?: string
  ): Promise<{ id: string, tags: string[], error?: Error }>;

  waitUntilDone(obj: { id: string, tags: string[] }): Promise<JobStatusEnum>;

  retryFailed(job: Job): Promise<{ id: string, tags: string[] }>;
}

export type JobParameters = { [p: string | number]: any };

export type Callback = (message: JobMessage) => void;
export type ErrorCallback = (error: Error, id: string, tags: string[]) => void;

export interface JobMessage {
  status: JobStatusEnum;
  id: string;
  tags: string[];
  error?: Error;
  log?: string;
  logLevel?: string;
  payload?: any;
}

export default class Jobs implements JobContract {

  private async catchJobMessage(message: JobMessage) {
    if (message.status === JobStatusEnum.LOGGING) {
      if (message.logLevel === "error" || message.error) {
        Logger.error("Error occurred in Job Id", message.id, message.tags, message.error?.name, message.error?.message, message.error?.stack);
      } else {
        Logger[message.logLevel || "info"](message.log);
      }
      return;
    }

    if (message.status === JobStatusEnum.MESSAGE) {
      return;
    }

    let isStarted = false;
    let isFinished = false;

    if (message.status === JobStatusEnum.FAILED) {
      isFinished = true;
      Logger.error("Job failed", message.id, message.tags, message.error?.name, message.error?.message);
    }

    if (message.status === JobStatusEnum.COMPLETED) {
      isFinished = true;
      Logger.info("Job completed", message.id, message.tags);
    }

    if (message.status === JobStatusEnum.RUNNING) {
      isStarted = true;
    }

    const defaultAppDateTimeFormat = Config.get("app.date_formats.default");

    await Job
      .query()
      .where("id", message.id)
      .where("tags", message.tags.join(","))
      .update({
        status: message.status,
        error: message.error?.message,
        errorStack: message.error?.stack,
        startedAt: isStarted ? toLuxon(new Date(), defaultAppDateTimeFormat) : null,
        finishedAt: isFinished ? toLuxon(new Date(), defaultAppDateTimeFormat) : null,
      })
      .exec();
  }

  private defaultCallback(message: JobMessage, callback?: Callback) {
    if (callback) {
      callback(message);
    }
    return this.catchJobMessage(message);
  }

  private defaultErrorCallback(error: Error, id: string, tags: string[] = [], errorCallBack?: ErrorCallback) {
    if (errorCallBack) {
      errorCallBack(error, id, tags);
    }
    return this.catchJobMessage({status: JobStatusEnum.FAILED, id, tags, error});
  }

  private getJobPath(jobName: string) {
    return path.resolve(Application.appRoot, "app", "Jobs", jobName);
  }

  private async jobIsRegistered(jobName: string): Promise<boolean> {
    try {
      const jobPath = this.getJobPath(jobName);
      return fs.existsSync(jobPath + ".js") || fs.existsSync(jobPath + ".ts");
    } catch (e) {
      Logger.error(e.message, e.stack);
      return false;
    }
  }

  async dispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags: string[] = [],
    callback?: Callback,
    errorCallback?: ErrorCallback,
  ): Promise<{ id: string, tags: string[] }> {

    if (!await this.jobIsRegistered(jobName)) {
      throw new Error("Job not registered");
    }

    Logger.info("Dispatching job on queue", jobName, tags);

    const id: string = require("uuid").v4();

    await Job.create({
      id,
      name: jobName,
      status: JobStatusEnum.DISPATCHED,
      tags: tags.join(","),
      parameters: JSON.stringify(parameters)
    });

    let jobCountRunning = await Job
      .query()
      .where("status", JobStatusEnum.RUNNING)
      .count("id")
      .exec();

    while (jobCountRunning.length > 8) {
      await new Promise(r => setTimeout(r, 2000));
      jobCountRunning = await Job
        .query()
        .where("status", JobStatusEnum.RUNNING)
        .count("id")
        .exec();
    }

    const worker = new Worker(
      path.join(Application.appRoot, "jobRunner.js"),
      {
        workerData: {
          jobName,
          id,
          tags,
          jobPath: this.getJobPath(jobName),
          ...parameters
        }
      }
    );

    worker.on("online", () => {
      Logger.info("Job started", id, tags);
    });

    worker.on("message", (message: JobMessage) => {
      this.defaultCallback(message, callback);
    });

    worker.on("error", (err: Error) => {
      this.defaultErrorCallback(err, id, tags, errorCallback);
    });

    return {
      id,
      tags
    };
  }

  async retryFailed(job: Job): Promise<{ id: string, tags: string[] }> {
    if (job.status !== JobStatusEnum.FAILED) {
      throw new Error("Job is not failed");
    }
    const parameters = JSON.parse(job.parameters || "{}");
    const tags = job.tags?.split(",") || [];
    return this.dispatch(job.name, parameters, tags);
  }

  async waitUntilDone(obj: { id: string, tags: string[] }): Promise<JobStatusEnum> {
    Logger.info("Waiting for job to finish", obj.id);

    let foundStatus = 0;

    while (true) {
      await new Promise(r => setTimeout(r, 2000));

      const found = await Job
        .query()
        .where("id", obj.id)
        .where("tags", obj.tags.join(","))
        .firstOrFail();

      foundStatus = found.status;

      if (!([JobStatusEnum.RUNNING, JobStatusEnum.DISPATCHED].includes(foundStatus as JobStatusEnum))) {
        break;
      }
    }

    Logger.info("Job finished", obj.id);

    return foundStatus;
  }

  async runWithoutDispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags: string[] = [],
    callback?: Callback,
    errorCallback?: ErrorCallback,
    id?: string
  ): Promise<{ id: string, tags: string[], error?: Error }> {

    if (!await this.jobIsRegistered(jobName)) {
      throw new Error("Job not registered");
    }

    Logger.info("Running job", jobName, tags, id);

    let resolver: (value?: Error) => void;

    const promise = new Promise<undefined | Error>((res) => {
      resolver = res;
    });

    let actualId = id || require("uuid").v4();

    const worker = new Worker(
      path.join(Application.appRoot, "jobRunner.js"),
      {
        workerData: {
          jobName,
          id: actualId,
          tags,
          jobPath: this.getJobPath(jobName),
          ...parameters
        }
      }
    );

    worker.on("message", (message: JobMessage) => {
      if (message.status === JobStatusEnum.COMPLETED || message.status === JobStatusEnum.FAILED) {
        resolver(undefined);
      }

      this.defaultCallback(message, callback);
    });

    worker.on("error", (err: Error) => {
      this.defaultErrorCallback(err, actualId, tags, errorCallback);
      resolver(err);
    });

    const err = await promise;

    Logger.info("Job finished", actualId, tags);

    return {
      id: actualId,
      tags,
      error: err
    };
  }
}
