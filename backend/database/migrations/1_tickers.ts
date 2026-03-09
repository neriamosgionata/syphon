import BaseSchema from '@ioc:Adonis/Lucid/Schema'

export default class Tickers extends BaseSchema {
  protected tableName = 'tickers'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('symbol', 20).notNullable().unique()
      table.string('name', 255).notNullable()
      table.string('exchange', 50).nullable()
      table.string('sector', 100).nullable()
      table.string('industry', 100).nullable()
      table.decimal('current_price', 12, 4).nullable()
      table.decimal('market_cap', 20, 2).nullable()
      table.json('metadata').nullable()
      table.boolean('is_active').defaultTo(true)
      table.timestamp('last_fetched_at').nullable()
      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
