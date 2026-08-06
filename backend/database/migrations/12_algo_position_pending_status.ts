import BaseSchema from '@ioc:Adonis/Lucid/Schema'

/**
 * Add 'pending_entry' status: an algo position whose entry order has been
 * submitted but not yet filled. Previously positions were marked 'open'
 * before the order filled, causing phantom exposure and premature exits.
 */
export default class AlgoPositionPendingStatus extends BaseSchema {
  protected tableName = 'algo_positions'

  public async up() {
    this.schema.raw(
      "ALTER TABLE algo_positions MODIFY status ENUM('open', 'pending_entry', 'closing', 'closed') NOT NULL DEFAULT 'open'"
    )
  }

  public async down() {
    this.schema.raw(
      "ALTER TABLE algo_positions MODIFY status ENUM('open', 'closing', 'closed') NOT NULL DEFAULT 'open'"
    )
  }
}
