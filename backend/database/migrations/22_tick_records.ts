import { BaseSchema } from '@adonisjs/lucid/schema'

export default class TickRecords extends BaseSchema {
  public async up() {
    this.schema.createTable('tick_records', (table) => {
      // 1-second aggregated bars recorded from the Kraken WS trade channel
      // (live recorder) or reconstructed from the REST Trades endpoint
      // (kraken:backfill). This is the Kraken-native replacement for the
      // removed Binance 1s kline cache — the only source with enough
      // granularity to backtest the 10s-decision fast algo honestly.
      table.increments('id')
      table.string('symbol', 10).notNullable()
      table.bigInteger('ts').notNullable()
      table.decimal('open', 20, 8).notNullable()
      table.decimal('high', 20, 8).notNullable()
      table.decimal('low', 20, 8).notNullable()
      table.decimal('close', 20, 8).notNullable()
      table.decimal('volume', 20, 8).notNullable()
      table.unique(['symbol', 'ts'])
      table.index(['symbol', 'ts'])
    })
  }

  public async down() {
    this.schema.dropTable('tick_records')
  }
}