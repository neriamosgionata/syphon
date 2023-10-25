import { JobStatusEnum } from "App/Enums/JobStatusEnum";
import { JobMessage } from "App/Services/Jobs/Jobs";

const retriveWorkerThreadsData = () => {
  const { parentPort, workerData } = require("worker_threads");
  return { parentPort, workerData };
};

const isRunning = async () => {
  const { parentPort, workerData } = retriveWorkerThreadsData();
  parentPort?.postMessage({ status: JobStatusEnum.RUNNING, id: workerData.id, tags: workerData.tags } as JobMessage);
};

const isFailed = async (err: Error) => {
  const { parentPort, workerData } = retriveWorkerThreadsData();
  parentPort?.postMessage({
    status: JobStatusEnum.FAILED,
    id: workerData.id,
    tags: workerData.tags,
    error: err
  } as JobMessage);
};

const isCompleted = async () => {
  const { parentPort, workerData } = retriveWorkerThreadsData();
  parentPort?.postMessage({ status: JobStatusEnum.COMPLETED, id: workerData.id, tags: workerData.tags } as JobMessage);
};

const loadData = (keys: string[]): { [p: string]: any } => {
  const { workerData } = retriveWorkerThreadsData();
  const data: { [p: string]: any } = {};

  for (const key of keys) {
    data[key] = workerData[key];
  }

  return data;
};

const runJob = (mainHandler: Function): RunJobFunction => {
  return async () => {
    await isRunning();

    try {
      await mainHandler();
      isCompleted().then(_ => _);
    } catch (err) {
      isFailed(err).then(_ => _);
    }
  };
};


type RunJobFunction = () => Promise<void>;

export {
  isRunning,
  isFailed,
  isCompleted,
  loadData,
  runJob,
  RunJobFunction
};
