import CurrencyConverter from "currency-converter-lt";
import Helper from "@ioc:Providers/Helper";
import Env from "@ioc:Adonis/Core/Env";

export interface CurrecyContract {
	convert({from, amount, to}: { from: string, amount?: number, to?: string }): Promise<number>;
}

export default class CurrencyService implements CurrecyContract {
	private _cache: any = {};

	private async cache(key: any, callback: Function, maxAge = Helper.ONE_DAY) {
		if (!this._cache[key] || this._cache[key].createdAt < Date.now() - maxAge) {
			this._cache[key] = {
				data: await callback(),
				createdAt: Date.now
			};
		}
		return this._cache[key].data;
	}

	async convert({from, amount = 1, to = Env.get('BASE_CURRENCY')}): Promise<number> {
		// @ts-ignore
		if (from.toLowerCase() === to.toLowerCase()) {
			return 1
		}

		const symbol = (from + to).toUpperCase()

		const result = await this.cache(symbol, async () => {
			const currencyConverter = new CurrencyConverter({from, to, amount: 1})
			return currencyConverter.convert()
		});

		return result * amount;
	}
}
