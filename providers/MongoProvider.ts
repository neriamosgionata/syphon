import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class MongoProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Mongo, () => {
      const Env = this.app.container.use("Adonis/Core/Env");

      return new (require("App/Services/Mongo/Mongo").default)(
        Env.get("MONGO_DSN"),
        Env.get("MONGO_DATABASE")
      );
    });
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
