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
}

type GetAllProgressBarsEmitData = {
  progressBars: {
    id: string;
    title: string;
    length: number;
    progress: number;
  }[];
}

type ProgressBarOnEmitData = {
  id: string;
  title: string;
  length: number;
}

type ProgressBarOffEmitData = {
  id: string;
}

type ProgressBarOffAllEmitData = {}

type ProgressBarIncrementEmitData = {
  id: string;
  steps: number;
}

type ProgressBarDecrementEmitData = {
  id: string;
  steps: number;
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
}

type AllJobsEmitData = {
  jobs: {
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
}

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

type AllAvailableJobsEmitData = JobNameForFrontend[];

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
}

export enum ListenEventType {
  START_JOB = "start_job",
  STOP_JOB = "stop_job",
  GET_JOB_STATUS = "get_job_status",
  GET_ALL_JOBS = "get_all_jobs"
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

type GetJobStatusListenData = {
  id: string;
}

type GetAllJobsListenData = {}

export type ListenEventTypeData = {
  [ListenEventType.START_JOB]: StartJobListenData,
  [ListenEventType.STOP_JOB]: StopJobListenData,
  [ListenEventType.GET_JOB_STATUS]: GetJobStatusListenData,
  [ListenEventType.GET_ALL_JOBS]: GetAllJobsListenData,
}
