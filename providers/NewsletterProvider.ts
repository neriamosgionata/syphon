import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class NewsletterProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Newsletter, () => new (require("App/Services/Newsletter/Newsletter").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
