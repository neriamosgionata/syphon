import { AppContainerAliasesEnum } from "App/Enums/AppContainerAliasesEnum";
import { ApplicationContract } from "@ioc:Adonis/Core/Application";
import Logger from "App/Services/Logger/Logger";

export default class LogServiceProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Logger, () => new Logger());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
