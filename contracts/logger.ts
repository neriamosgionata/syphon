declare module "@ioc:Providers/Logger" {
  import { LoggerContract } from "App/Services/Logger/Logger";
  const Logger: LoggerContract;
  export default Logger;
}
