import { BaseSchema } from '@adonisjs/lucid/schema'

export default class FastRiskRails extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Safety rails (0 = off)
      // Cap on TOTAL exposure across the (correlated) fast watchlist.
      table.decimal('fast_correlated_exposure_pct', 6, 3).defaultTo(0)
      // Position size so a full SL stop loses this % of equity.
      table.decimal('fast_risk_per_trade_pct', 6, 3).defaultTo(0)
      // Pause entries after this many consecutive losing closes.
      table.integer('fast_max_loss_streak').defaultTo(0)
      // Pause duration (0 = until the next winning close).
      table.integer('fast_loss_streak_pause_seconds').defaultTo(0)
      // Exit quality
      // Trailing distance scales with volatility: max(stop, mult * minuteVol).
      table.decimal('fast_trailing_volatility_mult', 6, 2).defaultTo(0)
      // Sell this fraction when the trailing stop arms (0-1).
      table.decimal('fast_scale_out_pct', 6, 3).defaultTo(0)
    })

    this.schema.alterTable('algo_positions', (table) => {
      // Scale-out bookkeeping: has the position scaled out, and partial PnL.
      table.boolean('scaled_out').defaultTo(false)
      table.decimal('scaled_out_pnl', 18, 8).nullable()
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_correlated_exposure_pct', 'fast_risk_per_trade_pct',
        'fast_max_loss_streak', 'fast_loss_streak_pause_seconds',
        'fast_trailing_volatility_mult', 'fast_scale_out_pct'
      )
    })

    this.schema.alterTable('algo_positions', (table) => {
      table.dropColumns('scaled_out', 'scaled_out_pnl')
    })
  }
}
