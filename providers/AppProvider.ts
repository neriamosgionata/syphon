import type {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class AppProvider {
  constructor(protected app: ApplicationContract) {
  }

  public register() {
  }

  public async boot() {
    const LocalStorageDriverService = (await import("App/Services/LocalStorageDriver/LocalStorageDriverService")).default;

    this.app.container.use("Adonis/Core/Drive")
      .extend('local-storage', (_drive, _diskName, config) => {
        return new LocalStorageDriverService(config, this.app.container.use("Adonis/Core/Route"))
      });
  }

  public async ready() {
  }

  public async shutdown() {
  }
}
