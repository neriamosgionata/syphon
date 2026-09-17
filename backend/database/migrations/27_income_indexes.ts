import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    // Indexes the income lines' polling/report queries need. The unique
    // keys on the original tables lead with symbol/strategy, so scan-heavy
    // predicates (ts ranges, status, ordered slices) could not use them.
    this.schema.alterTable('bar_records', (table) => {
      table.index('ts')
    })
    this.schema.alterTable('yield_rewards', (table) => {
      table.index(['time'])
      table.index(['asset', 'time'])
    })
    this.schema.alterTable('trend_evaluations', (table) => {
      table.index(['symbol', 'window_end'])
      table.index(['state', 'window_end'])
    })
    this.schema.alterTable('operation_alerts', (table) => {
      table.index(['created_at'])
    })
    this.schema.alterTable('operation_intents', (table) => {
      table.index(['status'])
    })
  }

  async down() {
    this.schema.alterTable('operation_intents', (table) => {
      table.dropIndex(['status'])
    })
    this.schema.alterTable('operation_alerts', (table) => {
      table.dropIndex(['created_at'])
    })
    this.schema.alterTable('trend_evaluations', (table) => {
      table.dropIndex(['state', 'window_end'])
      table.dropIndex(['symbol', 'window_end'])
    })
    this.schema.alterTable('yield_rewards', (table) => {
      table.dropIndex(['asset', 'time'])
      table.dropIndex(['time'])
    })
    this.schema.alterTable('bar_records', (table) => {
      table.dropIndex('ts')
    })
  }
}
