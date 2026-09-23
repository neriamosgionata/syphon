import { BaseSchema } from '@adonisjs/lucid/schema'

export default class JevScoreUsage extends BaseSchema {
  public async up() {
    this.schema.alterTable('ml_scores', (table) => {
      // Token usage per scored decision — the spend report (U7) prices
      // input tokens at the documented $0.042/MTok with free output.
      // Backfilled as zeros: pre-U7 rows keep their decisions, spend before
      // instrumentation reads as unknown rather than fabricated.
      table.integer('input_tokens').defaultTo(0)
      table.integer('output_tokens').defaultTo(0)
    })
  }

  public async down() {
    this.schema.alterTable('ml_scores', (table) => {
      table.dropColumns('input_tokens', 'output_tokens')
    })
  }
}
