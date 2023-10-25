declare module "@ioc:Providers/Jobs" {
  import { JobContract } from "App/Services/Jobs/Jobs";
  const Jobs: JobContract;
  export default Jobs;
}
