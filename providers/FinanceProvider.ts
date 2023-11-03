import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class LogServiceProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Finance, () => new (require("App/Services/Finance/Finance").default)(true));
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
