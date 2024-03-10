import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {DateTime} from "luxon";
import {JobName, JobNameForFrontend} from "App/Services/Jobs/JobsTypes";

export enum EmitEventType {
  GET_ALL_PROGRESS_BARS = "get_all_progress_bars",
  PROGRESS_BAR_ON = "progress_bar_on",
  PROGRESS_BAR_OFF = "progress_bar_off",
  PROGRESS_BAR_OFF_ALL = "progress_bar_off_all",
  PROGRESS_BAR_INCREMENT = "progress_bar_increment",
  PROGRESS_BAR_DECREMENT = "progress_bar_decrement",
  PROGRESS_BAR_CHANGE_TITLE = "progress_bar_change_title",
  PROGRESS_BAR_COMPLETE = "progress_bar_complete",
  PROGRESS_BAR_SET_PROGRESS = "progress_bar_set_progress",

  ALL_JOBS = "all_jobs",
  JOB_STATUS = "job_status",
  STARTED_JOB = "started_job",
  ALL_AVAILABLE_JOBS = "all_available_jobs",
  JOB_DELETED = "job_deleted",

  LOG_LINE = "log_line",
  ALL_LOGS = "all_logs",
  ALL_AVAILABLE_LOGS = "all_available_logs",
}

type GetAllProgressBarsEmitData = {
  id: string;
  title: string;
  length: number;
  progress: number;
  eta: number;
}[];

type ProgressBarOnEmitData = {
  id: string;
  title: string;
  length: number;
  eta: number;
}

type ProgressBarOffEmitData = {
  id: string;
}

type ProgressBarOffAllEmitData = {}

type ProgressBarIncrementEmitData = {
  id: string;
  steps: number;
  eta: number;
}

type ProgressBarDecrementEmitData = {
  id: string;
  steps: number;
  eta: number;
}

type ProgressBarChangeTitleEmitData = {
  id: string;
  title: string;
}

type ProgressBarCompleteEmitData = {
  id: string;
}

type ProgressBarSetProgressEmitData = {
  id: string;
  progress: number;
  eta: number;
}

type AllJobsEmitData = {
  id: string;
  name: JobName;
  tags: string | null;
  status: JobMessageEnum;
  parameters: string | null;
  error: string | null;
  errorStack: string | null;
  startedAt: DateTime | null;
  finishedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}[];

type JobStatusEmitData = {
  id: string;
  name: JobName;
  tags: string | null;
  status: JobMessageEnum;
  parameters: string | null;
  error: string | null;
  errorStack: string | null;
  startedAt: DateTime | null;
  finishedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
}

type StartedJobEmitData = {
  id: string;
  name: JobName;
  tags: string | null;
  status: JobMessageEnum;
  parameters: string | null;
  error: string | null;
  errorStack: string | null;
  startedAt: DateTime | null;
  finishedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};

type AllAvailableJobsEmitData = JobNameForFrontend;

type LogLineEmitData = {
  logLine: string;
}

type AllLogsEmitData = {
  logs: string[];
  name: string;
}

type AllAvailableLogsEmitData = {
  logs: string[];
}

type JobDeletedEmitData = {
  id: string;
}

export type EmitEventTypeData = {
  [EmitEventType.GET_ALL_PROGRESS_BARS]: GetAllProgressBarsEmitData,
  [EmitEventType.PROGRESS_BAR_ON]: ProgressBarOnEmitData,
  [EmitEventType.PROGRESS_BAR_OFF]: ProgressBarOffEmitData,
  [EmitEventType.PROGRESS_BAR_OFF_ALL]: ProgressBarOffAllEmitData,
  [EmitEventType.PROGRESS_BAR_INCREMENT]: ProgressBarIncrementEmitData,
  [EmitEventType.PROGRESS_BAR_DECREMENT]: ProgressBarDecrementEmitData,
  [EmitEventType.PROGRESS_BAR_CHANGE_TITLE]: ProgressBarChangeTitleEmitData,
  [EmitEventType.PROGRESS_BAR_COMPLETE]: ProgressBarCompleteEmitData,
  [EmitEventType.PROGRESS_BAR_SET_PROGRESS]: ProgressBarSetProgressEmitData,

  [EmitEventType.ALL_JOBS]: AllJobsEmitData,
  [EmitEventType.JOB_STATUS]: JobStatusEmitData,
  [EmitEventType.STARTED_JOB]: StartedJobEmitData,
  [EmitEventType.ALL_AVAILABLE_JOBS]: AllAvailableJobsEmitData,
  [EmitEventType.JOB_DELETED]: JobDeletedEmitData,

  [EmitEventType.LOG_LINE]: LogLineEmitData,
  [EmitEventType.ALL_LOGS]: AllLogsEmitData,
  [EmitEventType.ALL_AVAILABLE_LOGS]: AllAvailableLogsEmitData,
}

export enum ListenEventType {
  START_JOB = "start_job",
  STOP_JOB = "stop_job",
  RESTART_JOB = "restart_job",
  DELETE_JOB = "delete_job",
  GET_JOB_STATUS = "get_job_status",
  GET_ALL_JOBS = "get_all_jobs",

  GET_ALL_LOGS = "get_all_logs",
  SELECT_LOG = "select_log",
  DELETE_LOG = "delete_log",
}

type StartJobListenData = {
  id?: string;
  jobName: JobName;
  tags?: string[];
  parameters?: any;
}

type StopJobListenData = {
  id: string;
}

type RestartJobListenData = {
  id: string;
}

type GetJobStatusListenData = {
  id: string;
}

type GetAllJobsListenData = {}

type DeleteJobListenData = {
  id: string;
}

type SelectLogListenData = {
  name: string;
}

type GetAllLogsListenData = {}

type DeleteLogListenData = {
  name: string;
}

export type ListenEventTypeData = {
  [ListenEventType.START_JOB]: StartJobListenData,
  [ListenEventType.STOP_JOB]: StopJobListenData,
  [ListenEventType.RESTART_JOB]: RestartJobListenData,
  [ListenEventType.GET_JOB_STATUS]: GetJobStatusListenData,
  [ListenEventType.GET_ALL_JOBS]: GetAllJobsListenData,
  [ListenEventType.DELETE_JOB]: DeleteJobListenData,

  [ListenEventType.GET_ALL_LOGS]: GetAllLogsListenData,
  [ListenEventType.SELECT_LOG]: SelectLogListenData,
  [ListenEventType.DELETE_LOG]: DeleteLogListenData,
}
