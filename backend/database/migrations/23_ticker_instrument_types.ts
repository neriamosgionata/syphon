import { BaseSchema } from '@adonisjs/lucid/schema'

export default class TickerInstrumentTypes extends BaseSchema {
  public async up() {
    this.schema.alterTable('tickers', (table) => {
      // Instrument class — makes the whole app venue/instrument agnostic.
      // Existing rows are stocks/ETFs (IBKR-era seed), so 'stock' is the
      // backfill default; crypto rows created at runtime by the Kraken
      // engine carry sec_type='crypto' explicitly.
      table.string('sec_type', 20).defaultTo('stock')
      table.string('currency', 10).defaultTo('USD')
      // Order-size bounds for engines (Kraken lot sizes, IBKR odd-lots).
      table.decimal('min_qty', 20, 8).nullable()
      table.decimal('qty_step', 20, 8).nullable()
    })
  }

  public async down() {
    this.schema.alterTable('tickers', (table) => {
      table.dropColumns('sec_type', 'currency', 'min_qty', 'qty_step')
    })
  }
}