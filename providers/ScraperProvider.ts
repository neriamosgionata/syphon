import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class ScraperProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.bind(AppContainerAliasesEnum.Scraper, () => new (require("App/Services/Scraper/Scraper").default)());
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
    try {
      await this.app.container.use(AppContainerAliasesEnum.Scraper).end();
    } catch (e) {

    }
  }
}
