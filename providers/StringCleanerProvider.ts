import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class HelperProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.StringCleaner, () => new (require("App/Services/StringCleaner/StringCleaner").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
