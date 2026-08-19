import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AlgoFastMode extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Intraminute fast-trading mode (Kraken fast engine)
      table.boolean('fast_enabled').defaultTo(false)
      table.integer('fast_interval_seconds').defaultTo(10)
      table.json('fast_watchlist').nullable()

      // Momentum entry gate
      table.integer('fast_momentum_seconds').defaultTo(60)
      table.decimal('fast_momentum_threshold_pct', 6, 3).defaultTo(0.15)
      table.decimal('fast_rsi_low', 6, 2).defaultTo(35)
      table.decimal('fast_rsi_high', 6, 2).defaultTo(75)

      // Risk
      table.decimal('fast_stop_loss_pct', 6, 3).defaultTo(0.5)
      table.decimal('fast_take_profit_pct', 6, 3).defaultTo(1.0)
      table.decimal('fast_exit_reversal_pct', 8, 3).defaultTo(-0.3)
      table.integer('fast_cooldown_seconds').defaultTo(180)
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_enabled', 'fast_interval_seconds', 'fast_watchlist',
        'fast_momentum_seconds', 'fast_momentum_threshold_pct',
        'fast_rsi_low', 'fast_rsi_high',
        'fast_stop_loss_pct', 'fast_take_profit_pct',
        'fast_exit_reversal_pct', 'fast_cooldown_seconds'
      )
    })
  }
}
