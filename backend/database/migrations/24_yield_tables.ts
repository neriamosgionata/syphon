import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('yield_allocations', (table) => {
      table.increments('id')
      table.string('strategy_id', 64).notNullable().unique()
      table.string('asset', 16).notNullable()
      table.string('lock_type', 16).notNullable() // instant | bonded | timed | flex
      table.boolean('can_allocate').notNullable().defaultTo(false)
      table.string('auto_compound', 16).nullable() // enabled | disabled | optional
      table.decimal('allocated_native', 24, 12).notNullable().defaultTo(0)
      table.decimal('pending_native', 24, 12).notNullable().defaultTo(0)
      table.decimal('unbonding_native', 24, 12).notNullable().defaultTo(0)
      table.decimal('exit_queue_native', 24, 12).notNullable().defaultTo(0)
      table.decimal('total_rewarded_native', 24, 12).notNullable().defaultTo(0)
      table.decimal('baseline_rewarded_native', 24, 12).notNullable().defaultTo(0)
      table.integer('unbonding_seconds').nullable()
      table.decimal('min_allocation_usd', 18, 8).nullable()
      table.decimal('user_cap_usd', 18, 8).nullable()
      table.decimal('apy_low', 8, 4).nullable()
      table.decimal('apy_high', 8, 4).nullable()
      table.bigInteger('baseline_at').nullable() // epoch ms
      table.bigInteger('last_refreshed_at').nullable() // epoch ms
      table.timestamps()
    })

    this.schema.createTable('yield_rewards', (table) => {
      table.increments('id')
      table.string('refid', 64).notNullable().unique()
      table.bigInteger('time').notNullable() // venue settlement time, epoch ms
      table.string('ledger_type', 24).notNullable() // staking | reward | earn
      table.string('subtype', 32).nullable()
      table.string('asset', 16).notNullable()
      table.decimal('amount', 24, 12).notNullable()
      table.decimal('balance_after', 24, 12).nullable()
      table.string('strategy_id', 64).nullable()
      table.timestamps()
    })
  }

  async down() {
    this.schema.dropTable('yield_rewards')
    this.schema.dropTable('yield_allocations')
  }
}
