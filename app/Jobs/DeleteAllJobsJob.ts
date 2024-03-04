import {configureJob} from "App/Services/Jobs/JobHelpers";
import {BaseJobParameters} from "App/Services/Jobs/JobsTypes";
import Job from "App/Models/Job";
import Console from "@ioc:Providers/Console";


const handler = async () => {
	const jobs = await Job.query().delete();
	Console.log('Deleted ' + jobs + ' old jobs');
};

export interface DeleteAllJobsJobParameters extends BaseJobParameters {
}

export default configureJob(handler);
