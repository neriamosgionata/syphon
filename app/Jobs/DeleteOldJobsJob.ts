import {configureJob} from "App/Services/Jobs/JobHelpers";
import {BaseJobParameters} from "App/Services/Jobs/Jobs";
import Job from "App/Models/Job";
import Console from "@ioc:Providers/Console";


const handler = async () => {
  const jobs = await Job.query().where('created_at', '<', new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)).delete();
  Console.log('Deleted ' + jobs + ' old jobs');
};

export interface DeleteOldJobsJobParameters extends BaseJobParameters {
}

export default configureJob(handler);
