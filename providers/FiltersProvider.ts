import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class FiltersProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Filters, () => new (require("App/Services/Filters/Filters").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
