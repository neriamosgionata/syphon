import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import fs from "fs";
import Job from "App/Models/Job";
import Application from "@ioc:Adonis/Core/Application";
import {Worker} from "worker_threads";
import path from "path";
import {DateTime} from "luxon";
import Env from "@ioc:Adonis/Core/Env";
import {sendToWorker, socketEmit} from "App/Services/Jobs/JobHelpers";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {EmitEventType, EmitEventTypeData} from "App/Services/Socket/SocketTypes";
import {
  BaseJobParameters,
  Callback,
  ErrorCallback,
  JobMessage,
  JobName,
  JobRunInfo,
  JobWorkerData
} from "App/Services/Jobs/JobsTypes";
import {LogChannels} from "App/Services/Logger/Logger";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";
import Helper from "@ioc:Providers/Helper";

export interface JobContract {
  dispatch<T extends BaseJobParameters>(
    jobName: JobName,
    parameters: T,
    tags?: string[],
    idEx?: string
  ): Promise<{ id: string, tags: string[] }>;

  runJobQueue(): Promise<void>;

  dispatchSync<T extends BaseJobParameters>(
    jobName: JobName,
    parameters: T,
    tags?: string[],
    messageCallback?: (message: JobMessage) => void,
    errorCallback?: (error: Error, id: string, tags: string[]) => void,
    id?: string
  ): Promise<{ id: string, tags: string[], error?: Error }>;

  waitUntilDone(obj: { id: string, tags: string[] }): Promise<JobMessageEnum>;

  retryFailed(job: Job): Promise<{ id: string, tags: string[] }>;

  waitUntilAllDone(toWait: { id: string; tags: string[] }[]): Promise<JobMessageEnum[]>;

  jobIsRegistered(jobName: JobName): Promise<boolean>;

  getAllJobs(): Promise<Job[]>;

  getAllRunningJobs(): Promise<Job[]>;

  getAllDispatchedJobs(): Promise<Job[]>;

  getAllCompletedJobs(): Promise<Job[]>;

  getAllFailedJobs(): Promise<Job[]>;

  getSingleJob(id: string): Promise<Job>;

  stopJob(id: string): Promise<Job>;

  restartJob(id: string): Promise<Job>;

  deleteJob(id: string): Promise<Job>;

  socketEmitter(event: string, data: any): void;
}

export default class Jobs implements JobContract {

  runningJobs: Map<string, Worker> = new Map();

  getAllJobs() {
    return Job
      .query()
      .orderBy("created_at", "desc")
      .exec()
  }

  getAllRunningJobs() {
    return Job
      .query()
      .where("status", JobMessageEnum.RUNNING)
      .orderBy("created_at", "desc")
      .exec();
  }

  getAllDispatchedJobs() {
    return Job
      .query()
      .where("status", JobMessageEnum.DISPATCHED)
      .orderBy("created_at", "desc")
      .exec();
  }

  getAllCompletedJobs() {
    return Job
      .query()
      .where("status", JobMessageEnum.COMPLETED)
      .orderBy("created_at", "desc")
      .exec();
  }

  getAllFailedJobs() {
    return Job
      .query()
      .where("status", JobMessageEnum.FAILED)
      .orderBy("created_at", "desc")
      .exec();
  }

  getSingleJob(id: string) {
    return Job
      .query()
      .where("id", id)
      .firstOrFail();
  }

  private async catchJobMessage(message: JobMessage) {

    if (message.status === JobMessageEnum.FAILED || message.status === JobMessageEnum.STOPPED || message.status === JobMessageEnum.COMPLETED) {
      if (message.status === JobMessageEnum.FAILED) {
        Application.container.use(AppContainerAliasesEnum.Logger)
          .error(message.error?.message as string, message.error?.stack as string);
      }

      await Job
        .query()
        .where("id", message.id)
        .where("tags", message.tags.join(","))
        .update({
          status: message.status,
          error: message.error?.message,
          errorStack: message.error?.stack,
          finishedAt: DateTime.now().toISO()
        })
        .exec();

      return;
    }

    if (message.status === JobMessageEnum.RUNNING) {
      await Job
        .query()
        .where("id", message.id)
        .where("tags", message.tags.join(","))
        .update({
          status: message.status,
          error: message.error?.message,
          errorStack: message.error?.stack,
          startedAt: DateTime.now().toISO()
        })
        .exec();
    }

  }

  private defaultCallback(worker: Worker, message: JobMessage, messageCallback?: Callback, isDispatched?: boolean) {
    if (messageCallback && message.status === JobMessageEnum.MESSAGE) {
      messageCallback(message);
      return;
    }

    if (message.status === JobMessageEnum.LOGGING) {
      Application.container.use(AppContainerAliasesEnum.Logger)
        .logFromThread(
          message.logChannel as LogChannels,
          message.logMessage as string,
          message.logParameters as any[],
          message.logLevel as LogLevelEnum,
          message.logTable,
          message.logTableColumnNames,
          message.logLevelWriteTo,
        );
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_ON) {
      Application.container.use(AppContainerAliasesEnum.ProgressBar)
        .newBar(
          message.payload.total,
          message.payload.title,
          message.payload.progressBarIndex,
        )
        .then((progressBarIndex) => {
          sendToWorker(
            worker,
            {
              status: JobMessageEnum.PROGRESS_BAR_ON_INDEX,
              id: message.id,
              tags: message.tags,
              uuid: message.uuid,
              payload: {
                progressBarIndex
              }
            });
        });
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_UPDATE) {
      Application.container.use(AppContainerAliasesEnum.ProgressBar)
        .increment(message.payload.progressBarIndex, message.payload.current)
        .then(() => {
        })
        .catch(() => {
        });
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_OFF) {
      Application.container.use(AppContainerAliasesEnum.ProgressBar)
        .finish(message.payload.progressBarIndex)
        .then(() => {
        })
        .catch(() => {
        });
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_OFF_ALL) {
      Application.container.use(AppContainerAliasesEnum.ProgressBar)
        .finishAll()
        .then(() => {
        })
        .catch(() => {
        });
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_CHANGE_TITLE) {
      Application.container.use(AppContainerAliasesEnum.ProgressBar)
        .changeTitle(message.payload.progressBarIndex, message.payload.title)
        .then(() => {
        })
        .catch(() => {
        });
      return;
    }

    if (message.status === JobMessageEnum.PROGRESS_BAR_SET_PROGRESS) {
      Application.container.use(AppContainerAliasesEnum.ProgressBar)
        .setProgress(message.payload.progressBarIndex, message.payload.current)
        .then(() => {
        })
        .catch(() => {
        });
      return;
    }

    if (message.status === JobMessageEnum.SOCKET_EMIT) {
      Application.container.use(AppContainerAliasesEnum.Socket).emitToAdmins(message.payload.event, message.payload.data);
      return;
    }

    if (message.status === JobMessageEnum.CONSOLE_LOG) {
      Application.container.use(AppContainerAliasesEnum.Console)[message.payload.logLevel].call(this, message.payload.args);
      return;
    }

    if (isDispatched) {
      return this.catchJobMessage(message);
    }
  }

  private async defaultErrorCallback(error: Error, id: string, tags: string[] = [], errorCallBack?: ErrorCallback) {
    if (errorCallBack) {
      await errorCallBack(error, id, tags);
    }
    return this.catchJobMessage({status: JobMessageEnum.FAILED, id, tags, error});
  }

  private getJobPath(jobName: JobName) {
    return path.resolve(Application.appRoot, "app", "Jobs", jobName);
  }

  async jobIsRegistered(jobName: JobName): Promise<boolean> {
    try {
      const jobPath = this.getJobPath(jobName);
      return fs.existsSync(jobPath + ".js") || fs.existsSync(jobPath + ".ts");
    } catch (e) {
      Application.container.use(AppContainerAliasesEnum.Logger).error(e.message, e.stack);
      return false;
    }
  }

  async runJobQueue(): Promise<void> {
    while (true) {

      const jobsWaiting = await Job
        .query()
        .where("status", JobMessageEnum.DISPATCHED)
        .orderBy("created_at", "asc")
        .exec();

      const maxParallelJobs = Env.get("MAX_PARALLEL_JOBS") as number;

      const jobsToRun = jobsWaiting.splice(0, maxParallelJobs - this.runningJobs.size);

      for (const job of jobsToRun) {
        const parameters = typeof job.parameters === "object" ? job.parameters : JSON.parse(job.parameters || "{}");
        const tags = Array.isArray(job.tags) ? job.tags : (job.tags?.split(",") || []);

        const worker = new Worker(
          path.join(Application.appRoot, "jobRunner.js"),
          {
            workerData: {
              jobName: job.name,
              id: job.id,
              tags: tags,
              jobPath: this.getJobPath(job.name),
              ...parameters
            } as JobWorkerData<any>
          }
        );

        await Job
          .query()
          .where("id", job.id)
          .update({
            status: JobMessageEnum.RUNNING,
            startedAt: DateTime.now().toISO(),
            error: null,
            errorStack: null,
          })
          .exec();

        this.runningJobs.set(job.id, worker);

        const onlineListener = () => {
          Application.container.use(AppContainerAliasesEnum.Console).info(`Job ${job.id} - ${job.name} started`);
        };

        const messageListener = (worker: Worker, message: JobMessage) => {
          return this.defaultCallback(worker, message, undefined, true);
        };

        const errorListener = (err: Error) => {
          this.defaultErrorCallback(err, job.id, tags, undefined);
        };

        worker.on("online", onlineListener);
        worker.on("message", (m: JobMessage) => messageListener(worker, m));
        worker.on("error", errorListener);
        worker.on("exit", () => {
          Application.container.use(AppContainerAliasesEnum.Console).info(`Job ${job.id} - ${job.name} Finished`);

          worker.removeAllListeners();

          this.runningJobs.delete(job.id);
        });

      }

      await Application.container.use(AppContainerAliasesEnum.Helper).wait(2000);
    }
  }

  async dispatch<T extends BaseJobParameters>(
    jobName: JobName,
    parameters: T,
    tags: string[] = [],
    idEx?: string,
  ): Promise<JobRunInfo> {
    if (!await this.jobIsRegistered(jobName)) {
      throw new Error("Job not registered");
    }

    const id: string = idEx || require("uuid").v4();

    const job = await Job.find(id);

    if (!job) {
      await Job.create({
        id,
        name: jobName,
        status: JobMessageEnum.DISPATCHED,
        tags: tags.join(","),
        parameters: JSON.stringify(parameters)
      });
    } else {
      await Job
        .query()
        .where("id", id)
        .update({
          name: jobName,
          status: JobMessageEnum.DISPATCHED,
          tags: tags.join(","),
          parameters: JSON.stringify(parameters)
        })
        .exec();
    }

    return {
      id,
      jobName,
      tags
    };
  }

  async dispatchSync<T extends BaseJobParameters>(
    jobName: JobName,
    parameters: T,
    tags: string[] = [],
    messageCallback?: Callback,
    errorCallback?: ErrorCallback,
    id?: string,
  ): Promise<JobRunInfo> {

    if (!await this.jobIsRegistered(jobName)) {
      throw new Error("Job not registered");
    }

    let resolver: (value?: Error) => void;

    const promise = new Promise<undefined | Error>((res) => {
      resolver = res;
    });

    const actualId: any = id || require("uuid").v4();

    const worker = new Worker(
      path.join(Application.appRoot, "jobRunner.js"),
      {
        workerData: {
          jobName,
          id: actualId,
          tags,
          jobPath: this.getJobPath(jobName),
          ...parameters
        } as JobWorkerData<any>
      }
    );

    this.runningJobs.set(actualId, worker);

    const onlineListener = () => {
    };

    const messageListener = (worker: Worker, message: JobMessage) => {
      if (message.status === JobMessageEnum.COMPLETED || message.status === JobMessageEnum.FAILED) {
        return;
      }

      return this.defaultCallback(worker, message, messageCallback, false);
    };

    const errorListener = (err: Error) => {
      if (errorCallback) {
        errorCallback(err, actualId, tags)
      }
    };

    worker.on("online", onlineListener);
    worker.on("message", (m: JobMessage) => messageListener(worker, m));
    worker.on("error", errorListener);
    worker.on("exit", () => {
      worker.removeAllListeners();

      this.runningJobs.delete(actualId);

      resolver();
    });

    const err = await promise;

    return {
      id: actualId,
      jobName,
      tags,
      error: err
    };
  }

  async waitUntilDone(obj: JobRunInfo): Promise<JobMessageEnum> {
    return await this.waitForJobOnDB(obj);
  }

  async waitUntilAllDone(objArray: JobRunInfo[]): Promise<JobMessageEnum[]> {
    const statuses: JobMessageEnum[] = [];

    for (const objIndex in objArray) {
      const obj = objArray[objIndex];

      statuses[objIndex] = await this.waitForJobOnDB(obj);
    }

    return statuses;
  }

  async retryFailed(job: Job): Promise<JobRunInfo> {
    if (job.status !== JobMessageEnum.FAILED) {
      throw new Error("Job is not failed");
    }
    const parameters = JSON.parse(job.parameters || "{}");
    const tags = job.tags?.split(",") || [];
    return this.dispatch(job.name, parameters, tags);
  }

  private async waitForJobOnDB(obj: { id: string, tags: string[] }): Promise<JobMessageEnum> {
    let foundStatus = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await Helper.wait(2000);

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

    return foundStatus;
  }

  async stopJob(id: string) {
    const worker = this.runningJobs.get(id);

    if (worker) {
      await worker.terminate();
      this.runningJobs.delete(id);
    }

    await Job
      .query()
      .where("id", id)
      .update({
        status: JobMessageEnum.STOPPED,
        error: "Job was stopped",
        errorStack: null,
        finishedAt: DateTime.now().toISO()
      })
      .exec();

    return this.getSingleJob(id);
  }

  async restartJob(id: string) {
    const job = await this.getSingleJob(id);

    if (job.status === JobMessageEnum.RUNNING) {
      throw new Error("Job is already running");
    }

    await this.dispatch(job.name, job.parameters || {}, job.tags?.split(",") || [], job.id);

    return job;
  }

  async deleteJob(id: string) {
    const job = await this.getSingleJob(id);

    if (job.status === JobMessageEnum.RUNNING) {
      throw new Error("Job is running");
    }

    await Job
      .query()
      .where("id", id)
      .delete();

    return job;
  }

  socketEmitter<K extends EmitEventType>(event: K, data: EmitEventTypeData[K]) {
    socketEmit(event, data);
  }
}
