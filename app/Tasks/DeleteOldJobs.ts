import {BaseTask, CronTimeV2} from 'adonis5-scheduler/build/src/Scheduler/Task'
import Jobs from '@ioc:Providers/Jobs';
import {DeleteOldJobsJobParameters} from "App/Jobs/DeleteOldJobsJob";

export default class DeleteOldJobs extends BaseTask {
  public static get schedule() {
    return CronTimeV2.everyDayAt(11, 30);
  }

  public static get useLock() {
    return true;
  }

  public async handle() {
    await Jobs.dispatch<DeleteOldJobsJobParameters>(
      "DeleteOldJobsJob",
      {}
    );
  }
}
