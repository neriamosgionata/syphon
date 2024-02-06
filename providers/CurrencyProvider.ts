import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ApplicationContract} from "@ioc:Adonis/Core/Application";

export default class CurrencyProvider {
	constructor(protected app: ApplicationContract) {
	}

	public register() {
		this.app.container.singleton(AppContainerAliasesEnum.Currency, () => new (require("App/Services/Currency/CurrencyService").default)());
	}

	public async boot() {
	}

	public async ready() {
	}

	public async shutdown() {
	}
}
