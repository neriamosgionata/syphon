import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {BaseJobParameters, JobMessage, JobWorkerData} from "App/Services/Jobs/Jobs";
import type {MessagePort} from "worker_threads";

export const retriveWorkerThreadsData = <T extends BaseJobParameters>(): {
  parentPort: MessagePort,
  workerData: JobWorkerData<T>
} => {
  const {parentPort, workerData} = require("worker_threads");
  return {parentPort, workerData};
};

export const isRunning = <T extends BaseJobParameters>() => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({status: JobMessageEnum.RUNNING, id: workerData.id, tags: workerData.tags} as JobMessage);
};

export const isFailed = <T extends BaseJobParameters>(err: Error) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.FAILED,
    id: workerData.id,
    tags: workerData.tags,
    error: err
  } as JobMessage);
};

export const isCompleted = <T extends BaseJobParameters>() => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({status: JobMessageEnum.COMPLETED, id: workerData.id, tags: workerData.tags} as JobMessage);
};

export const loadJobParameters = <T extends BaseJobParameters>(): T => {
  const {workerData} = retriveWorkerThreadsData<T>();
  return workerData as T;
};

export const logMessage = <T extends BaseJobParameters>(log: string, logLevel: string = "info") => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.LOGGING,
    id: workerData.id,
    tags: workerData.tags,
    log,
    logLevel
  } as JobMessage);
};

export const messageToParent = <T extends BaseJobParameters>(payload: any) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.MESSAGE,
    id: workerData.id,
    tags: workerData.tags,
    payload
  } as JobMessage);
}

export const configureJob = (mainHandler: () => void | Promise<void>): RunJobFunction => {
  return async () => {
    isRunning();

    try {
      await mainHandler();
      isCompleted();
    } catch (err) {
      isFailed(err);
    }
  };
};

export const progressBarOn = <T extends BaseJobParameters>(progressBarIndex: number, total: number, title?: string) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_ON,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      title,
      total,
      progressBarIndex
    }
  } as JobMessage);
}

export const progressBarUpdate = <T extends BaseJobParameters>(progressBarIndex: number, current: number) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_UPDATE,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      current,
      progressBarIndex,
    }
  } as JobMessage);
}

export const progressBarOff = <T extends BaseJobParameters>(progressBarIndex: number) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_OFF,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      progressBarIndex,
    }
  } as JobMessage);
}

export const progressBarOffAll = <T extends BaseJobParameters>() => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_OFF_ALL,
    id: workerData.id,
    tags: workerData.tags,
    payload: {}
  } as JobMessage);
}

export const registerCallbackToParentMessage = <T extends BaseJobParameters>(callback: (parentMessage: JobMessage) => void) => {
  const {parentPort} = retriveWorkerThreadsData<T>();
  parentPort?.on("message", callback);
}

export const sendToWorker = (worker: any, status: JobMessageEnum, payload: any) => {
  worker.postMessage(
    {
      status,
      payload
    } as JobMessage
  );
}

export const consoleLog = <T extends BaseJobParameters>(logLevel: string = "info", ...args: any[]) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.CONSOLE_LOG,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      logLevel,
      args,
    }
  } as JobMessage);
}

export type RunJobFunction = () => Promise<void>;
