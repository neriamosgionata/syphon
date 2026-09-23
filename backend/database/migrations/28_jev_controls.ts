import { BaseSchema } from '@adonisjs/lucid/schema'

export default class JevControls extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // Jev advisory overlay: veto entries on confident-negative reads.
      // All-off defaults = deterministic behavior, as before.
      table.boolean('fast_jev_gate_enabled').defaultTo(false)
      table.decimal('fast_jev_min_confidence', 6, 4).defaultTo(0.5)
      table.decimal('fast_jev_min_edge_pct', 6, 4).defaultTo(0.15)
      table.integer('fast_jev_timeout_ms').defaultTo(2000)
      // Shadow-only default: record scores without influencing decisions
      // until the overlay is explicitly enforced (U6 promotion).
      table.boolean('fast_jev_shadow_only').defaultTo(true)
    })

    this.schema.createTable('ml_scores', (table) => {
      // Append-only Jev score store: every live score recorded with its
      // full attribution tuple (U4 replays these; rows are never updated).
      table.increments('id')
      table.string('symbol', 20).notNullable()
      table.bigInteger('decided_at').notNullable()
      table.string('model', 64).notNullable()
      table.string('question_hash', 64).notNullable()
      table.string('prompt_version', 32).notNullable().defaultTo('v1')
      table.integer('window_seconds').notNullable().defaultTo(0)
      table.decimal('p_up', 8, 6).nullable()
      table.decimal('p_down', 8, 6).nullable()
      table.decimal('confidence', 8, 6).nullable()
      table.integer('latency_ms').nullable()
      table.boolean('stale').defaultTo(false)
      table.boolean('fixture').defaultTo(false)
      table.index(['symbol', 'decided_at'])
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_jev_gate_enabled', 'fast_jev_min_confidence',
        'fast_jev_min_edge_pct', 'fast_jev_timeout_ms', 'fast_jev_shadow_only'
      )
    })
    this.schema.dropTable('ml_scores')
  }
}
