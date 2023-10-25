import MongoDB from "App/Services/Mongo/Mongo";
import { AppContainerAliasesEnum } from "App/Enums/AppContainerAliasesEnum";
import { ApplicationContract } from "@ioc:Adonis/Core/Application";
import Env from "@ioc:Adonis/Core/Env";


export default class MongoProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    const mongo = new MongoDB(
      Env.get("MONGO_DSN"),
      Env.get("MONGO_DATABASE")
    );

    mongo.connect();

    this.app.container.singleton(AppContainerAliasesEnum.Mongo, () => mongo);
  }

  public async boot() {
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
