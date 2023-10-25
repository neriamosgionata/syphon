import { AppContainerAliasesEnum } from "App/Enums/AppContainerAliasesEnum";
import { ApplicationContract } from "@ioc:Adonis/Core/Application";

export default class ChartsProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Profiler, () => new (require("App/Services/Profiler/Profiler").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
