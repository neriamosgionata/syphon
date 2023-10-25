import { JobStatusEnum } from "App/Enums/JobStatusEnum";
import fs from "fs";
import Job from "App/Models/Job";
import Application from "@ioc:Adonis/Core/Application";
import Logger from "@ioc:Providers/Logger";
import { Worker } from "worker_threads";
import path from "path";

export interface JobContract {
  dispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags?: string[],
    callback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void
  ): Promise<{ id: string, tags: string[] }>;

  waitUntilDone(obj: { id: string, tags: string[] }): Promise<JobStatusEnum>;

  retryFailed(job: Job): Promise<{ id: string, tags: string[] }>;
}

export type JobParameters = { [p: string]: any };

export interface JobMessage {
  status: JobStatusEnum;
  id: string;
  tags: string[];
  error?: Error;
}

export default class Jobs implements JobContract {

  private async updateJobStatus(message: JobMessage) {
    if (message.status === JobStatusEnum.FAILED) {
      await Logger.error("Job failed", message.id, message.tags, message.error?.name, message.error?.message);
    }

    if (message.status === JobStatusEnum.COMPLETED) {
      await Logger.info("Job completed", message.id, message.tags);
    }

    return Job
      .query()
      .where("id", message.id)
      .where("tags", message.tags.join(","))
      .update({
        status: message.status,
        error: message.error?.message,
        errorStack: message.error?.stack
      })
      .exec();
  }

  private defaultCallback(message: JobMessage) {
    return this.updateJobStatus(message);
  }

  private defaultErrorCallback(error: Error, id: string, tags: string[] = []) {
    return this.updateJobStatus({ status: JobStatusEnum.FAILED, id, tags, error });
  }

  private getJobPath(jobName: string) {
    return path.resolve(Application.appRoot, "app", "Jobs", jobName + ".ts");
  }

  private jobIsRegistered(jobName: string): boolean {
    try {
      return fs.existsSync(this.getJobPath(jobName));
    } catch (e) {
      return false;
    }
  }

  async dispatch<T extends JobParameters>(
    jobName: string,
    parameters: T,
    tags: string[] = [],
    callback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void
  ): Promise<{ id: string, tags: string[] }> {

    if (!this.jobIsRegistered(jobName)) {
      throw new Error("Job not registered");
    }

    Logger.info("Dispatching job", jobName, tags);

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
      if (callback) {
        callback(message);
        return;
      }

      this.defaultCallback(message);
    });

    worker.on("error", (err: Error) => {
      if (errorCallback) {
        errorCallback(err, id, tags);
        return;
      }

      this.defaultErrorCallback(err, id, tags);
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
}
