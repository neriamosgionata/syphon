import { BaseSchema } from '@adonisjs/lucid/schema'

export default class FastSignalUpgrades extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // HAR multi-horizon vol forecast (Corsi 2009) for SL/TP scaling, the
      // vol ceiling, trailing width and vol targeting. 0 = single-window stddev.
      table.boolean('fast_har_vol_forecast').defaultTo(false)

      // CUSUM trend-break exit: cumulative price-vs-EMA deviation over the
      // window (s) triggers an exit at +/- this % (changepoint-detection
      // analog — Wood, Roberts & Zohren 2021). 0 = off.
      table.integer('fast_cusum_window_seconds').defaultTo(0)
      table.decimal('fast_cusum_exit_pct', 6, 3).defaultTo(0)

      // Jump-aware SL slack: a single-sample down move >= this % in the vol
      // window widens the stop by (1 + slack/100). Negative jumps raise
      // near-term risk (Hu, Härdle & Kuo 2021). 0 = off.
      table.decimal('fast_jump_slack_pct', 6, 3).defaultTo(0)

      // Choppiness entry gate: require close-based CHOP <= max over the
      // period (samples) — stand aside in ranging markets. 0 = off.
      table.integer('fast_choppiness_period').defaultTo(0)
      table.decimal('fast_choppiness_max', 5, 2).defaultTo(0)

      // Session gate: trade only in [start, end) UTC hours (time-of-day
      // vol/volume seasonality — Saef et al. 2021). 0/24 = always.
      table.integer('fast_trade_start_utc').defaultTo(0)
      table.integer('fast_trade_end_utc').defaultTo(24)

      // Conviction sizing: scale position size with signal strength vs its
      // threshold (deterministic mirror of learned sizing, Lim et al. 2019).
      table.boolean('fast_conviction_sizing').defaultTo(false)

      // Assumed execution slippage in bps per side for backtests/TCA.
      table.decimal('fast_slippage_bps', 6, 2).defaultTo(0)
    })

    // Migration 18 shipped an optimistic maker fee (0.08%); Kraken's base
    // tier is 0.16%. Fix existing rows so maker-mode backtests stay honest.
    this.defer(async (db) => {
      await db.rawQuery('UPDATE algo_configs SET fast_maker_fee_pct = ? WHERE fast_maker_fee_pct <= ?', [0.0016, 0.0008])
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_har_vol_forecast', 'fast_cusum_window_seconds', 'fast_cusum_exit_pct',
        'fast_jump_slack_pct', 'fast_choppiness_period', 'fast_choppiness_max',
        'fast_trade_start_utc', 'fast_trade_end_utc', 'fast_conviction_sizing',
        'fast_slippage_bps'
      )
    })
  }
}
