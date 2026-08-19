import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddBrokerToTrades extends BaseSchema {
  protected tableName = 'trades'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('broker', 20).defaultTo('ibkr').notNullable()
      table.string('external_order_id', 100).nullable()
      table.index(['broker', 'status'])
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex(['broker', 'status'])
      table.dropColumn('external_order_id')
      table.dropColumn('broker')
    })
  }
}
