import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    // Append-only record of every mutating Earn operation. Identity fields
    // are written once; only the terminal status and timing advance.
    this.schema.createTable('operation_intents', (table) => {
      table.increments('id')
      table.string('strategy_id', 64).notNullable()
      table.string('asset', 16).notNullable()
      table.string('type', 16).notNullable() // allocate | deallocate
      table.string('status', 16).notNullable() // pending | submitted | success | failed
      table.decimal('amount_native', 24, 12).nullable()
      table.decimal('amount_usd', 18, 8).nullable()
      table.decimal('price_usd', 18, 8).nullable()
      table.string('refid', 64).nullable()
      table.string('error', 255).nullable()
      table.bigInteger('created_at').notNullable() // epoch ms
      table.bigInteger('submitted_at').nullable()
      table.bigInteger('terminal_at').nullable()
      table.index(['strategy_id', 'status'])
    })

    // Persisted alerts: in-process events do not survive cron/worker process
    // boundaries, so status surfaces read these rows (KTD9).
    this.schema.createTable('operation_alerts', (table) => {
      table.increments('id')
      table.string('source', 32).notNullable() // yield | trend | shared
      table.string('severity', 16).notNullable() // info | warning | critical
      table.string('code', 48).notNullable()
      table.string('message', 512).notNullable()
      table.bigInteger('created_at').notNullable()
      table.bigInteger('acknowledged_at').nullable()
      table.index(['source', 'acknowledged_at'])
    })

    // Scheduler locks, heartbeats, and latching trip states (KTD10).
    this.schema.createTable('control', (table) => {
      table.increments('id')
      table.string('name', 48).notNullable().unique()
      table.string('owner', 64).nullable()
      table.string('state', 24).nullable() // running | halted
      table.bigInteger('lease_expires_at').nullable()
      table.bigInteger('heartbeat_at').nullable()
      table.json('detail')
      table.timestamps()
    })
  }

  async down() {
    this.schema.dropTable('control')
    this.schema.dropTable('operation_alerts')
    this.schema.dropTable('operation_intents')
  }
}
