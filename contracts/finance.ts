declare module "@ioc:Providers/Finance" {
  import { FinanceContract } from "App/Services/Finance/Finance";
  const Finance: FinanceContract;
  export default Finance;
}
