import { BaseSchema } from '@adonisjs/lucid/schema'

export default class JevScoreEnforced extends BaseSchema {
  public async up() {
    this.schema.alterTable('ml_scores', (table) => {
      table.boolean('enforced').defaultTo(true)
    })
  }

  public async down() {
    this.schema.alterTable('ml_scores', (table) => {
      table.dropColumn('enforced')
    })
  }
}
