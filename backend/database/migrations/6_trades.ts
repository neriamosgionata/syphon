import BaseSchema from '@ioc:Adonis/Lucid/Schema'

export default class Trades extends BaseSchema {
  protected tableName = 'trades'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.integer('ticker_id').unsigned().notNullable().references('id').inTable('tickers').onDelete('CASCADE')
      table.string('symbol', 20).notNullable()
      table.enum('side', ['BUY', 'SELL']).notNullable()
      table.enum('order_type', ['MKT', 'LMT', 'STP', 'STP_LMT', 'TRAIL']).notNullable()
      table.integer('quantity').notNullable()
      table.decimal('limit_price', 12, 4).nullable()
      table.decimal('stop_price', 12, 4).nullable()
      table.decimal('trail_amount', 12, 4).nullable()
      table.string('time_in_force', 10).defaultTo('DAY')
      table.integer('ib_order_id').nullable()
      table.string('ib_perm_id', 50).nullable()
      table.enum('status', [
        'pending', 'submitted', 'pre_submitted',
        'filled', 'partially_filled',
        'cancelled', 'error', 'inactive',
      ]).defaultTo('pending')
      table.decimal('fill_price', 12, 4).nullable()
      table.integer('filled_quantity').defaultTo(0)
      table.decimal('commission', 10, 4).nullable()
      table.decimal('realized_pnl', 14, 4).nullable()
      table.string('error_message', 500).nullable()
      table.string('exchange', 50).defaultTo('SMART')
      table.string('currency', 10).defaultTo('USD')
      table.json('ib_metadata').nullable()
      table.integer('analysis_id').unsigned().nullable().references('id').inTable('analyses').onDelete('SET NULL')
      table.timestamp('submitted_at').nullable()
      table.timestamp('filled_at').nullable()
      table.timestamp('cancelled_at').nullable()
      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })

      table.index(['ticker_id', 'status'])
      table.index(['status', 'created_at'])
      table.index(['ib_order_id'])
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
