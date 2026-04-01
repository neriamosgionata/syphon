import BaseSchema from '@ioc:Adonis/Lucid/Schema'

export default class AlgoPositions extends BaseSchema {
  protected tableName = 'algo_positions'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.integer('ticker_id').unsigned().notNullable().references('id').inTable('tickers').onDelete('CASCADE')
      table.string('symbol', 20).notNullable()
      table.enum('side', ['BUY', 'SELL']).notNullable()
      table.integer('quantity').notNullable()
      table.decimal('entry_price', 12, 4).notNullable()
      table.decimal('current_price', 12, 4).nullable()
      table.decimal('stop_loss', 12, 4).notNullable()
      table.decimal('take_profit', 12, 4).notNullable()
      table.decimal('entry_score', 6, 2).notNullable()
      table.decimal('entry_conviction', 3, 2).notNullable()
      table.string('entry_regime', 30).notNullable()
      table.string('entry_reason', 500).notNullable()
      table.integer('entry_trade_id').unsigned().notNullable().references('id').inTable('trades').onDelete('CASCADE')
      table.integer('exit_trade_id').unsigned().nullable().references('id').inTable('trades').onDelete('SET NULL')
      table.decimal('exit_price', 12, 4).nullable()
      table.string('exit_reason', 500).nullable()
      table.decimal('realized_pnl', 14, 4).nullable()
      table.enum('status', ['open', 'closing', 'closed']).defaultTo('open')
      table.boolean('force_close').defaultTo(false)
      table.timestamp('opened_at', { useTz: true }).notNullable()
      table.timestamp('closed_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })

      table.index(['status'])
      table.index(['symbol', 'status'])
      table.index(['status', 'opened_at'])
    })

    // Add FK from algo_decisions.algo_position_id now that the table exists
    this.schema.alterTable('algo_decisions', (table) => {
      table.foreign('algo_position_id').references('id').inTable('algo_positions').onDelete('SET NULL')
    })
  }

  public async down() {
    this.schema.alterTable('algo_decisions', (table) => {
      table.dropForeign(['algo_position_id'])
    })
    this.schema.dropTable(this.tableName)
  }
}
