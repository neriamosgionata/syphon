declare module "@ioc:Providers/Profiler" {
  import { ProfilerContract } from "App/Services/Profiler/Profiler";
  const Profiler: ProfilerContract;
  export default Profiler;
}
