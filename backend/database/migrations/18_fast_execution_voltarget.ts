import { BaseSchema } from '@adonisjs/lucid/schema'

export default class FastExecutionAndVolTarget extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Maker (limit) execution for ENTRIES — taker fees ~3x maker on Kraken.
      // Exits stay MARKET (reliability > cost). 0 = MARKET entries.
      table.boolean('fast_maker_execution').defaultTo(false)
      // Wait this long for a limit fill before cancelling + retrying.
      table.integer('fast_limit_fill_seconds').defaultTo(15)
      // Place the buy limit this % above the decision price to improve fills.
      table.decimal('fast_limit_offset_pct', 6, 3).defaultTo(0.05)
      // Fee assumption for limit fills (backtest + TCA).
      table.decimal('fast_maker_fee_pct', 6, 4).defaultTo(0.0008)

      // Volatility targeting: portfolio exposure scaled so realized vol
      // matches a target (Moreira-Muir). 0 = off.
      table.decimal('fast_vol_target_pct', 6, 3).defaultTo(0)
      // Realized-vol window (1s samples) for the target.
      table.integer('fast_vol_target_window_seconds').defaultTo(3600)
      // Cap on the exposure multiplier.
      table.decimal('fast_vol_target_max_mult', 4, 2).defaultTo(2)
    })

    this.schema.alterTable('algo_positions', (table) => {
      // The price the decision was made at — enables TCA (fill vs decision).
      table.decimal('decision_price', 18, 8).nullable()
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_maker_execution', 'fast_limit_fill_seconds', 'fast_limit_offset_pct',
        'fast_maker_fee_pct', 'fast_vol_target_pct', 'fast_vol_target_window_seconds',
        'fast_vol_target_max_mult'
      )
    })

    this.schema.alterTable('algo_positions', (table) => {
      table.dropColumns('decision_price')
    })
  }
}
