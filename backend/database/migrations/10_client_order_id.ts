import { BaseSchema } from '@adonisjs/lucid/schema'

export default class TradesClientOrderId extends BaseSchema {
  protected tableName = 'trades'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('client_order_id', 64).nullable()
      table.index(['client_order_id'])
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex(['client_order_id'])
      table.dropColumn('client_order_id')
    })
  }
}
