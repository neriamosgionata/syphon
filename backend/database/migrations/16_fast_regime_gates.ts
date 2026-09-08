import { BaseSchema } from '@adonisjs/lucid/schema'

export default class FastRegimeGates extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Regime gate (trend mode): stand aside unless a slow EMA slope shows
      // the market is actually trending. 0 = off.
      table.integer('fast_regime_ema_period').defaultTo(0)
      table.integer('fast_regime_slope_window_seconds').defaultTo(3600)
      table.decimal('fast_regime_slope_min_pct', 8, 4).defaultTo(0.02)
      // Volume confirmation: entry bar volume >= rolling-median ratio.
      // Backtest-only data source (cached OHLC klines); live feed has no
      // per-tick volume so the gate is lenient (skipped) live.
      table.integer('fast_volume_window_seconds').defaultTo(300)
      table.decimal('fast_volume_min_ratio', 6, 3).defaultTo(0)
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_regime_ema_period', 'fast_regime_slope_window_seconds',
        'fast_regime_slope_min_pct', 'fast_volume_window_seconds',
        'fast_volume_min_ratio'
      )
    })
  }
}
