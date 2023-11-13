import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import fs from "fs";
import Job from "App/Models/Job";
import Application from "@ioc:Adonis/Core/Application";
import Logger from "@ioc:Providers/Logger";
import {Worker} from "worker_threads";
import path from "path";
import {toLuxon} from "@adonisjs/validator/build/src/Validations/date/helpers/toLuxon";
import Config from "@ioc:Adonis/Core/Config";
import ProgressBar from "@ioc:Providers/ProgressBar";
import {now} from "moment";

export interface JobContract {
  dispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags?: string[],
    payloadCallback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void
  ): Promise<{ id: string, tags: string[] }>;

  runWithoutDispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags?: string[],
    payloadCallback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void,
    id?: string
  ): Promise<{ id: string, tags: string[], error?: Error }>;

  waitUntilDone(obj: { id: string, tags: string[] }): Promise<JobMessageEnum>;

  retryFailed(job: Job): Promise<{ id: string, tags: string[] }>;

  waitUntilAllDone(toWait: { id: string; tags: string[] }[]): Promise<JobMessageEnum[]>;
}

export type JobParameters = { [p: string | number]: any };

export type Callback = (message: JobMessage) => Promise<void> | void;
export type ErrorCallback = (error: Error, id: string, tags: string[]) => Promise<void> | void;

export interface JobMessage {
  status: JobMessageEnum;
  id: string;
  tags: string[];
  error?: Error;
  log?: string;
  logLevel?: string;
  payload?: any;
}

export default class Jobs implements JobContract {

  private async catchJobMessage(message: JobMessage) {
    let isStarted = false;
    let isFinished = false;

    if (message.status === JobMessageEnum.FAILED) {
      isFinished = true;
      Logger.error("Job failed", message.id, message.tags, message.error?.name, message.error?.message);
    }

    if (message.status === JobMessageEnum.COMPLETED) {
      isFinished = true;
      Logger.info("Job completed", message.id, message.tags);
    }

    if (message.status === JobMessageEnum.RUNNING) {
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
        startedAt: isStarted ? toLuxon(now(), defaultAppDateTimeFormat) : null,
        finishedAt: isFinished ? toLuxon(now(), defaultAppDateTimeFormat) : null,
      })
      .exec();
  }

  private async defaultCallback(message: JobMessage, payloadCallback?: Callback) {
    if (payloadCallback && message.status === JobMessageEnum.MESSAGE) {
      await payloadCallback(message);
      return;
    }

    if (message.status === JobMessageEnum.LOGGING) {
      Logger[message.logLevel || "info"](message.log, message.id, message.tags);
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_ON) {
      ProgressBar.addBar(message.payload.total, message.payload.title, message.payload.progressBarIndex);
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_UPDATE) {
      ProgressBar.next(message.payload.progressBarIndex, message.payload.current);
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_OFF) {
      ProgressBar.stop(message.payload.progressBarIndex);
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_OFF_ALL) {
      ProgressBar.stopAll();
      return;
    }

    return this.catchJobMessage(message);
  }

  private async defaultErrorCallback(error: Error, id: string, tags: string[] = [], errorCallBack?: ErrorCallback) {
    if (errorCallBack) {
      await errorCallBack(error, id, tags);
    }
    return this.catchJobMessage({status: JobMessageEnum.FAILED, id, tags, error});
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
    payloadCallback?: Callback,
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
      status: JobMessageEnum.DISPATCHED,
      tags: tags.join(","),
      parameters: JSON.stringify(parameters)
    });

    let jobCountRunning = await Job
      .query()
      .where("status", JobMessageEnum.RUNNING)
      .count("id")
      .exec();

    while (jobCountRunning.length > 8) {
      await new Promise(r => setTimeout(r, 2000));
      jobCountRunning = await Job
        .query()
        .where("status", JobMessageEnum.RUNNING)
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
      this.defaultCallback(message, payloadCallback);
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
    if (job.status !== JobMessageEnum.FAILED) {
      throw new Error("Job is not failed");
    }
    const parameters = JSON.parse(job.parameters || "{}");
    const tags = job.tags?.split(",") || [];
    return this.dispatch(job.name, parameters, tags);
  }

  async runWithoutDispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags: string[] = [],
    payloadCallback?: Callback,
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

    worker.on("online", () => {
      Logger.info("Job started", id, tags);
    });

    worker.on("message", (message: JobMessage) => {
      if (message.status === JobMessageEnum.COMPLETED || message.status === JobMessageEnum.FAILED) {
        resolver(undefined);
        return;
      }

      payloadCallback && payloadCallback(message);
    });

    worker.on("error", (err: Error) => {
      resolver(err);

      errorCallback && errorCallback(err, actualId, tags)
    });

    const err = await promise;

    Logger.info("Job finished", actualId, tags);

    return {
      id: actualId,
      tags,
      error: err
    };
  }

  async waitUntilDone(obj: { id: string, tags: string[] }): Promise<JobMessageEnum> {
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

      if (!([JobMessageEnum.RUNNING, JobMessageEnum.DISPATCHED].includes(foundStatus as JobMessageEnum))) {
        break;
      }
    }

    Logger.info("Job finished", obj.id);

    return foundStatus;
  }

  async waitUntilAllDone(objArray: { id: string, tags: string[] }[]): Promise<JobMessageEnum[]> {
    let statuses: JobMessageEnum[] = [];

    for (const objIndex in objArray) {
      const obj = objArray[objIndex];
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

        if (!([JobMessageEnum.RUNNING, JobMessageEnum.DISPATCHED].includes(foundStatus as JobMessageEnum))) {
          break;
        }
      }

      statuses[objIndex] = foundStatus;

      Logger.info("Job finished", obj.id);
    }

    return statuses;
  }
}
