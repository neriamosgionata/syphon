import {BaseTask, CronTimeV2} from 'adonis5-scheduler/build/src/Scheduler/Task'
import {ScrapeYahooFinanceForTickersJobParameters} from "App/Jobs/ScrapeYahooFinanceForTickersJob";
import Jobs from '@ioc:Providers/Jobs';

export default class ScrapeYahoo extends BaseTask {
  public static get schedule() {
    return CronTimeV2.everyDayAt(11, 30);
  }

  public static get useLock() {
    return true;
  }

  public async handle() {
    await Jobs.waitUntilDone(
      await Jobs.dispatch<ScrapeYahooFinanceForTickersJobParameters>(
        "ScrapeYahooFinanceForTickersJob",
        {}
      )
    );
  }
}
