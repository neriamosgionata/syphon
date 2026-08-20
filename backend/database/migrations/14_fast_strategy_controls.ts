import { BaseSchema } from '@adonisjs/lucid/schema'

export default class FastStrategyControls extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Trailing stop loss (0 = off)
      table.decimal('fast_trailing_stop_pct', 6, 3).defaultTo(0.3)
      // Profit % that arms the trailing stop (0 = off)
      table.decimal('fast_trailing_activate_pct', 6, 3).defaultTo(0.4)
      // Force-close positions held longer than this (0 = off)
      table.integer('fast_max_hold_seconds').defaultTo(1800)
      // EMA trend filter for entries (0 = off)
      table.integer('fast_ema_period').defaultTo(20)
      // Volatility window (seconds of samples) for adaptive SL/TP (0 = off)
      table.integer('fast_volatility_window_seconds').defaultTo(60)
      // SL distance = stopLossPct * max(1, mult * minuteVolPct / stopLossPct)
      table.decimal('fast_volatility_mult', 6, 2).defaultTo(2.0)
      // Ignore measured volatility below this (per-minute %)
      table.decimal('fast_volatility_floor_pct', 6, 3).defaultTo(0.05)
      // Skip entries when per-minute volatility exceeds this (0 = no ceiling)
      table.decimal('fast_volatility_ceiling_pct', 6, 3).defaultTo(0)
    })

    this.schema.alterTable('algo_positions', (table) => {
      // Highest price seen since entry (BUY) — trailing stop anchor
      table.decimal('peak_price', 18, 8).nullable()
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_trailing_stop_pct', 'fast_trailing_activate_pct',
        'fast_max_hold_seconds', 'fast_ema_period',
        'fast_volatility_window_seconds', 'fast_volatility_mult',
        'fast_volatility_floor_pct', 'fast_volatility_ceiling_pct'
      )
    })

    this.schema.alterTable('algo_positions', (table) => {
      table.dropColumns('peak_price')
    })
  }
}
