import { AppContainerAliasesEnum } from "App/Enums/AppContainerAliasesEnum";
import { ApplicationContract } from "@ioc:Adonis/Core/Application";

export default class ChartsProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Charts, () => new (require("App/Services/Charts/Charts").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
