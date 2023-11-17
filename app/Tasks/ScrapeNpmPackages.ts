import {BaseTask, CronTimeV2} from 'adonis5-scheduler/build/src/Scheduler/Task'
import Jobs from '@ioc:Providers/Jobs';
import {ScrapeNpmRegistryJobParameters} from "App/Jobs/ScrapeNpmRegistryJob";

export default class ScrapeNpmPackages extends BaseTask {
  public static get schedule() {
    return CronTimeV2.everyMonthOn(15, 11, 30);
  }

  public static get useLock() {
    return true;
  }

  public async handle() {
    await Jobs.waitUntilDone(
      await Jobs.dispatch<ScrapeNpmRegistryJobParameters>(
        "ScrapeNpmRegistryJob",
        {}
      )
    );
  }
}
