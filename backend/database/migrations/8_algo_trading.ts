import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AlgoTrading extends BaseSchema {
  public async up() {
    this.schema.createTable('algo_configs', (table) => {
      table.increments('id')

      // Master controls
      table.boolean('enabled').defaultTo(false)
      table.boolean('dry_run').defaultTo(true)
      table.string('broker', 20).defaultTo('ibkr')

      // Entry criteria
      table.integer('entry_score_threshold').defaultTo(30)
      table.decimal('min_conviction', 3, 2).defaultTo(0.40)
      table.integer('min_articles').defaultTo(1)
      table.json('allowed_regimes') // ["trending_up","ranging"]

      // Portfolio constraints
      table.integer('max_positions').defaultTo(10)
      table.decimal('max_exposure_pct', 5, 2).defaultTo(0.80)
      table.decimal('max_single_position_pct', 5, 2).defaultTo(0.15)
      table.decimal('daily_loss_limit_pct', 5, 2).defaultTo(0.03)

      // Exit criteria
      table.integer('exit_score_threshold').defaultTo(-10)
      table.integer('max_holding_days').defaultTo(30)

      // Execution
      table.string('order_type', 10).defaultTo('MKT')
      table.string('time_in_force', 10).defaultTo('DAY')
      table.integer('cooldown_minutes').defaultTo(5)

      // Filters
      table.json('excluded_symbols') // []

      // State
      table.timestamp('last_run_at').nullable()
      table.string('disabled_reason', 500).nullable()

      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })
    })

    this.schema.createTable('algo_decisions', (table) => {
      table.increments('id')
      table.string('run_id', 36).notNullable()
      table.string('symbol', 20).notNullable()
      table.integer('ticker_id').unsigned().notNullable().references('id').inTable('tickers').onDelete('CASCADE')
      table.enum('decision', ['enter', 'exit', 'hold', 'skip']).notNullable()
      table.string('reason', 500).notNullable()
      table.enum('side', ['BUY', 'SELL']).nullable()
      table.integer('quantity').nullable()
      table.decimal('composite_score', 6, 2).nullable()
      table.decimal('conviction', 3, 2).nullable()
      table.string('regime', 30).nullable()
      table.decimal('position_size_pct', 5, 2).nullable()
      table.decimal('stop_loss', 12, 4).nullable()
      table.decimal('take_profit', 12, 4).nullable()
      table.integer('trade_id').unsigned().nullable().references('id').inTable('trades').onDelete('SET NULL')
      table.integer('algo_position_id').unsigned().nullable()
      table.json('context').nullable()
      table.timestamp('created_at', { useTz: true })

      table.index(['run_id'])
      table.index(['symbol', 'created_at'])
      table.index(['decision', 'created_at'])
    })
  }

  public async down() {
    this.schema.dropTable('algo_decisions')
    this.schema.dropTable('algo_configs')
  }
}
