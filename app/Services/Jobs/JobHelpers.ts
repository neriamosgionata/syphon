import {JobStatusEnum} from "App/Enums/JobStatusEnum";
import {JobMessage} from "App/Services/Jobs/Jobs";

export const retriveWorkerThreadsData = () => {
  const {parentPort, workerData} = require("worker_threads");
  return {parentPort, workerData};
};

export const isRunning = () => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({status: JobStatusEnum.RUNNING, id: workerData.id, tags: workerData.tags} as JobMessage);
};

export const isFailed = (err: Error) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({
    status: JobStatusEnum.FAILED,
    id: workerData.id,
    tags: workerData.tags,
    error: err
  } as JobMessage);
};

export const isCompleted = () => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({status: JobStatusEnum.COMPLETED, id: workerData.id, tags: workerData.tags} as JobMessage);
};

export const loadData = <T extends { [p: string | number]: any }>(keys: string[]): T => {
  const {workerData} = retriveWorkerThreadsData();
  const data: T = {} as T;

  for (const key of keys) {
    data[key as any] = workerData[key];
  }

  return data;
};

export const logMessage = (log: string, logLevel: string = "info", error?: Error) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({
    status: JobStatusEnum.LOGGING,
    id: workerData.id,
    tags: workerData.tags,
    log,
    logLevel,
    error
  } as JobMessage);
};

export const messageToParent = (payload: any) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({
    status: JobStatusEnum.MESSAGE,
    id: workerData.id,
    tags: workerData.tags,
    payload
  } as JobMessage);
}

export const runJob = (mainHandler: () => void | Promise<void>): RunJobFunction => {
  return async () => {
    isRunning();

    try {
      await mainHandler();
      isCompleted()
    } catch (err) {
      isFailed(err)
    }
  };
};

export type RunJobFunction = () => Promise<void>;
