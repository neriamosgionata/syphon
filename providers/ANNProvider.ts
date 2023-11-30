import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class ANNProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.ANN, () => new (require("App/Services/ANN/ANN").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
