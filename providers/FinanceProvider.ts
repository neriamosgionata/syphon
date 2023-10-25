import { AppContainerAliasesEnum } from "App/Enums/AppContainerAliasesEnum";
import { ApplicationContract } from "@ioc:Adonis/Core/Application";
import Finance from "App/Services/Finance/Finance";

export default class LogServiceProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Finance, () => new Finance());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
