import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Add 'pending_entry' status: an algo position whose entry order has been
 * submitted but not yet filled. Previously positions were marked 'open'
 * before the order filled, causing phantom exposure and premature exits.
 *
 * MariaDB: raw ALTER to widen the ENUM.
 * SQLite: knex cannot alter CHECK constraints; the 4-value enum is already
 * declared in the create-table migration (9_algo_positions) — no-op here.
 */
export default class AlgoPositionPendingStatus extends BaseSchema {
  protected tableName = 'algo_positions'

  public async up() {
    if (this.db.dialect.name === 'mysql') {
      this.schema.raw(
        "ALTER TABLE algo_positions MODIFY status ENUM('open', 'pending_entry', 'closing', 'closed') NOT NULL DEFAULT 'open'"
      )
    }
  }

  public async down() {
    if (this.db.dialect.name === 'mysql') {
      this.schema.raw(
        "ALTER TABLE algo_positions MODIFY status ENUM('open', 'closing', 'closed') NOT NULL DEFAULT 'open'"
      )
    }
  }
}
