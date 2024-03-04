import {ApplicationContract} from "@ioc:Adonis/Core/Application";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";

export default class SocketProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
    this.app.container.singleton(AppContainerAliasesEnum.Socket, () => new (require("App/Services/Socket/SocketService").default)());
  }

  public async boot() {
  }

  public async ready() {
    await this.app.container.use(AppContainerAliasesEnum.Socket).startServer();
  }

  public async shutdown() {
    await this.app.container.use(AppContainerAliasesEnum.Socket).stopServer();
  }
}
