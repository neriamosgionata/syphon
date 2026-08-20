import { BaseSchema } from '@adonisjs/lucid/schema'

export default class FastTrendMode extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Trend-rider entry mode (0 = off): price above EMA + EMA slope gate,
      // replaces the momentum+RSI gate; takeProfitPct 0 = no take profit.
      table.boolean('fast_trend_mode').defaultTo(false)
      table.decimal('fast_trend_slope_pct', 8, 4).defaultTo(0.05)
      table.integer('fast_trend_slope_window_seconds').defaultTo(1800)
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns('fast_trend_mode', 'fast_trend_slope_pct', 'fast_trend_slope_window_seconds')
    })
  }
}
