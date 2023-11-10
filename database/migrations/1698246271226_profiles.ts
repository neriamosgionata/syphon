import BaseSchema from '@ioc:Adonis/Lucid/Schema'
import {ProfileQuoteTypeEnum} from "App/Enums/ProfileQuoteTypeEnum";
import {ProfileMarketStateEnum} from "App/Enums/ProfileMarketStateEnum";

export default class extends BaseSchema {
  protected tableName = 'profiles'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.string('ticker').notNullable()
      table.dateTime("index_date", {useTz: true}).notNullable()

      table.string('language').nullable()
      table.string('region').nullable()
      table.enum('quote_type', [
        ProfileQuoteTypeEnum.CRYPTOCURRENCY,
        ProfileQuoteTypeEnum.CURRENCY,
        ProfileQuoteTypeEnum.ETF,
        ProfileQuoteTypeEnum.EQUITY,
        ProfileQuoteTypeEnum.FUTURE,
        ProfileQuoteTypeEnum.INDEX,
        ProfileQuoteTypeEnum.OPTION,
        ProfileQuoteTypeEnum.MUTUALFUND,
      ]).nullable()
      table.string('quote_source_name').nullable()
      table.string('currency').nullable()
      table.enum('market_state', [
        ProfileMarketStateEnum.REGULAR,
        ProfileMarketStateEnum.CLOSED,
        ProfileMarketStateEnum.PRE,
        ProfileMarketStateEnum.PREPRE,
        ProfileMarketStateEnum.POST,
        ProfileMarketStateEnum.POSTPOST,
      ]).nullable()
      table.boolean('tradeable').nullable()
      table.boolean('crypto_tradeable').nullable()
      table.string('exchange').nullable()
      table.string('short_name').nullable()
      table.string('long_name').nullable()
      table.string('exchange_timezone_name').nullable()
      table.string('exchange_timezone_short_name').nullable()
      table.string('market').nullable()
      table.dateTime('dividend_date', {useTz: true}).nullable()
      table.float('trailing_annual_dividend_rate').nullable()
      table.float('trailing_pe').nullable()
      table.float('trailing_annual_dividend_yield').nullable()
      table.float('eps_trailing_twelve_months').nullable()
      table.float('eps_forward').nullable()
      table.float('eps_current_year').nullable()
      table.float('price_eps_current_year').nullable()
      table.float('shares_outstanding').nullable()
      table.float('book_value').nullable()
      table.float('market_cap').nullable()
      table.string('financial_currency').nullable()
      table.float('average_daily_volume_3_month').nullable()
      table.float('average_daily_volume_10_day').nullable()
      table.string('display_name').nullable()

      table.float('ytd_return').nullable()
      table.string('prev_name').nullable()
      table.string('average_analyst_rating').nullable()
      table.float('open_interest').nullable()

      /**
       * Uses timestamptz for PostgreSQL and DATETIME2 for MSSQL
       */
      table.timestamp('created_at', {useTz: true})
      table.timestamp('updated_at', {useTz: true})

      table.index(['ticker', 'index_date'], 'profiles_ticker_index_date_index')
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
