import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class LogServiceProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Logger, () => new (require("App/Services/Logger/Logger").default)("daily"));
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
