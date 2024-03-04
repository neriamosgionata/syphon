import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {BaseJobParameters, JobMessage, JobWorkerData} from "App/Services/Jobs/JobsTypes";
import type {MessagePort, Worker} from "worker_threads";
import {LogLevelEnum} from "App/Enums/LogLevelEnum";
import {isEqual} from "lodash";
import {EmitEventType, EmitEventTypeData} from "App/Services/Socket/SocketTypes";

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

export const logMessage = <T extends BaseJobParameters>(
  logMessage: string,
  logParameters: any[],
  logLevel: LogLevelEnum = LogLevelEnum.INFO,
  logTable?: any[],
  logTableColumnNames?: string[],
  logLevelWriteTo: LogLevelEnum = LogLevelEnum.INFO,
) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.LOGGING,
    id: workerData.id,
    tags: workerData.tags,
    logMessage,
    logParameters,
    logLevel,
    logTable,
    logTableColumnNames,
    logLevelWriteTo
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

export const progressBarOn = <T extends BaseJobParameters>(progressBarIndex?: string, total?: number, title?: string): Promise<string> => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();

  const uuid = require("uuid").v4();

  return new Promise((resolve) => {

    const listener = (message: JobMessage) => {
      if (
        message.status === JobMessageEnum.PROGRESS_BAR_ON_INDEX &&
        message.id === workerData.id &&
        message.uuid === uuid &&
        isEqual(message.tags, workerData.tags)
      ) {
        resolve(message.payload.progressBarIndex as string);
        parentPort?.off("message", listener);
      }
    };

    parentPort?.on("message", listener);

    parentPort?.postMessage({
      status: JobMessageEnum.PROGRESS_BAR_ON,
      id: workerData.id,
      tags: workerData.tags,
      uuid,
      payload: {
        title,
        total,
        progressBarIndex
      }
    } as JobMessage);
  });
}

export const progressBarUpdate = <T extends BaseJobParameters>(progressBarIndex: string, current: number) => {
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

export const progressBarOff = <T extends BaseJobParameters>(progressBarIndex: string) => {
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

export const progressBarChangeTitle = <T extends BaseJobParameters>(progressBarIndex: string, title: string): void => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();

  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_CHANGE_TITLE,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      title,
      progressBarIndex
    }
  } as JobMessage);
}

export const progressBarSetProgress = <T extends BaseJobParameters>(progressBarIndex: string, current: number) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.PROGRESS_BAR_SET_PROGRESS,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      current,
      progressBarIndex
    }
  } as JobMessage);

}

export const socketEmit = <T extends BaseJobParameters, K extends EmitEventType>(event: K, data: EmitEventTypeData[K]) => {
  const {parentPort, workerData} = retriveWorkerThreadsData<T>();
  parentPort?.postMessage({
    status: JobMessageEnum.SOCKET_EMIT,
    id: workerData.id,
    tags: workerData.tags,
    payload: {
      event,
      data
    }
  } as JobMessage);
}

export const registerCallbackToParentMessage = <T extends BaseJobParameters>(callback: (parentMessage: JobMessage) => void) => {
  const {parentPort} = retriveWorkerThreadsData<T>();
  parentPort?.on("message", callback);
}

export const sendToWorker = (worker: Worker, message: JobMessage) => {
  worker.postMessage(message);
}

export const consoleLog = <T extends BaseJobParameters>(logLevel: LogLevelEnum = LogLevelEnum.INFO, args: any[]) => {
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
