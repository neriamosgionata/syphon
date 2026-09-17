import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    // Multi-interval Kraken bars (>= 60s). tick_records stays the 1s store;
    // this table is the slow-trend / evaluation series (KTD5).
    this.schema.createTable('bar_records', (table) => {
      table.increments('id')
      table.string('symbol', 16).notNullable()
      table.integer('interval_seconds').notNullable()
      table.bigInteger('ts').notNullable() // bar open time, epoch ms
      table.decimal('open', 24, 12).notNullable()
      table.decimal('high', 24, 12).notNullable()
      table.decimal('low', 24, 12).notNullable()
      table.decimal('close', 24, 12).notNullable()
      table.decimal('volume', 24, 12).notNullable().defaultTo(0)
      table.unique(['symbol', 'interval_seconds', 'ts'])
      table.timestamps()
    })

    // Single-row frozen trend config in FastStrategy sample units (KTD7).
    this.schema.createTable('trend_configs', (table) => {
      table.increments('id')
      table.string('name', 32).notNullable().unique()
      table.boolean('trend_mode').notNullable().defaultTo(true)
      table.integer('ema_period').notNullable()
      table.decimal('trend_slope_pct', 8, 4)
      table.integer('trend_slope_window_seconds')
      table.integer('regime_ema_period')
      table.integer('regime_slope_window_seconds')
      table.decimal('regime_slope_min_pct', 8, 4)
      table.integer('efficiency_window_days')
      table.decimal('efficiency_min_pct', 8, 4)
      table.decimal('efficiency_exit_pct', 8, 4)
      table.decimal('stop_loss_pct', 8, 4)
      table.decimal('take_profit_pct', 8, 4)
      table.decimal('exit_reversal_pct', 8, 4)
      table.decimal('trailing_stop_pct', 8, 4)
      table.decimal('trailing_activate_pct', 8, 4)
      table.integer('cooldown_seconds')
      table.integer('max_hold_seconds')
      table.integer('loop_interval_seconds')
      table.decimal('capital_per_asset_usd', 18, 8)
      table.decimal('taker_fee_pct', 8, 4)
      table.decimal('slippage_bps', 8, 4)
      table.integer('max_positions')
      table.decimal('max_exposure_pct', 8, 4)
      table.decimal('max_single_position_pct', 8, 4)
      table.json('extras')
      table.string('config_hash', 64)
      table.timestamps()
    })

    // Append-only replay snapshots (one row per evaluator run).
    this.schema.createTable('trend_evaluations', (table) => {
      table.increments('id')
      table.string('symbol', 16).notNullable()
      table.integer('interval_seconds').notNullable()
      table.bigInteger('window_start')
      table.bigInteger('window_end')
      table.integer('bars')
      table.decimal('equity', 18, 8)
      table.decimal('net_return_pct', 12, 6)
      table.decimal('max_drawdown_pct', 12, 6)
      table.decimal('profit_factor', 12, 6)
      table.integer('green_months')
      table.integer('trade_count')
      table.string('state', 16).notNullable()
      table.boolean('provisional').notNullable().defaultTo(true)
      table.boolean('coverage_ok').notNullable().defaultTo(false)
      table.string('config_hash', 64)
      table.json('config_snapshot')
      table.json('monthly')
      table.json('quarterly')
      table.timestamps()
    })
  }

  async down() {
    this.schema.dropTable('trend_evaluations')
    this.schema.dropTable('trend_configs')
    this.schema.dropTable('bar_records')
  }
}
