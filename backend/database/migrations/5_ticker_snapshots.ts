import BaseSchema from '@ioc:Adonis/Lucid/Schema'

export default class TickerSnapshots extends BaseSchema {
  protected tableName = 'ticker_snapshots'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.integer('ticker_id').unsigned().notNullable().references('id').inTable('tickers').onDelete('CASCADE')
      table.decimal('open', 12, 4).nullable()
      table.decimal('high', 12, 4).nullable()
      table.decimal('low', 12, 4).nullable()
      table.decimal('close', 12, 4).nullable()
      table.bigInteger('volume').nullable()
      table.decimal('change_percent', 8, 4).nullable()
      table.date('date').notNullable()
      table.timestamp('created_at', { useTz: true })

      table.unique(['ticker_id', 'date'])
      table.index(['ticker_id', 'date'])
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
