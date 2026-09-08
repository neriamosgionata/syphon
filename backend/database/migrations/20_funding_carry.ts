import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'carry_positions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('symbol', 16).notNullable() // e.g. BTC
      table.boolean('dry_run').notNullable().defaultTo(true)
      table.string('status', 24).notNullable().defaultTo('monitoring') // monitoring | opening | open | closing | halted
      table.decimal('spot_notional', 18, 8).nullable()
      table.decimal('perp_notional', 18, 8).nullable()
      table.decimal('spot_quantity', 18, 8).nullable()
      table.decimal('perp_quantity', 18, 8).nullable()
      table.decimal('entry_spot_price', 18, 8).nullable()
      table.decimal('entry_perp_price', 18, 8).nullable()
      table.decimal('funding_received_usd', 18, 8).notNullable().defaultTo(0)
      table.decimal('basis_usd', 18, 8).notNullable().defaultTo(0)
      table.decimal('spot_pnl_usd', 18, 8).notNullable().defaultTo(0)
      table.decimal('perp_pnl_usd', 18, 8).notNullable().defaultTo(0)
      table.timestamp('opened_at').nullable()
      table.timestamp('last_rebalance_at').nullable()
      table.timestamp('last_funding_at').nullable()
      table.timestamp('halted_at').nullable()
      table.string('halt_reason', 255).nullable()
      table.json('meta').nullable()
      table.timestamps()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}