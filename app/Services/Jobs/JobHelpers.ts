import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {JobMessage} from "App/Services/Jobs/Jobs";

export interface BaseJobParameters {
  id?: string,
  tags?: string[],
  progressBarIndex?: number,
}

export const retriveWorkerThreadsData = () => {
  const {parentPort, workerData} = require("worker_threads");
  return {parentPort, workerData};
};

export const isRunning = () => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({status: JobMessageEnum.RUNNING, id: workerData.id, tags: workerData.tags} as JobMessage);
};

export const isFailed = (err: Error) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({
    status: JobMessageEnum.FAILED,
    id: workerData.id,
    tags: workerData.tags,
    error: err
  } as JobMessage);
};

export const isCompleted = () => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({status: JobMessageEnum.COMPLETED, id: workerData.id, tags: workerData.tags} as JobMessage);
};

export const loadData = <T extends BaseJobParameters>(keys: string[]): T => {
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
    status: JobMessageEnum.LOGGING,
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
    status: JobMessageEnum.MESSAGE,
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

export const progressBarOn = (progressBarIndex: number, total: number, title?: string) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
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

export const progressBarUpdate = (progressBarIndex: number, current: number) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
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

export const progressBarOff = (progressBarIndex: number) => {
  const {parentPort, workerData} = retriveWorkerThreadsData();
  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_OFF,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      progressBarIndex,
    }
  } as JobMessage);
}

export const registerCallbackToParentMessage = (callback: (parentMessage: JobMessage) => void) => {
  const {parentPort} = retriveWorkerThreadsData();
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

export type RunJobFunction = () => Promise<void>;
