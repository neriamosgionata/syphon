import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Crypto pairs trade in fractional units (e.g. 0.5 BTC). INTEGER columns
 * silently truncated fractional quantities, corrupting fills and P&L.
 *
 * MariaDB needs raw ALTERs (ENUM/DECIMAL MODIFY unsupported by knex's
 * table.enum/table.decimal). SQLite already declares DECIMAL columns in the
 * create-table migrations (stored as REAL) — nothing to do here.
 */
export default class DecimalQuantities extends BaseSchema {
  public async up() {
    if (this.db.dialect.name === 'mysql') {
      this.schema.raw('ALTER TABLE trades MODIFY quantity DECIMAL(18,8) NOT NULL')
      this.schema.raw('ALTER TABLE trades MODIFY filled_quantity DECIMAL(18,8) NOT NULL DEFAULT 0')
      this.schema.raw('ALTER TABLE algo_positions MODIFY quantity DECIMAL(18,8) NOT NULL')
    }
  }

  public async down() {
    if (this.db.dialect.name === 'mysql') {
      this.schema.raw('ALTER TABLE trades MODIFY quantity INT NOT NULL')
      this.schema.raw('ALTER TABLE trades MODIFY filled_quantity INT NOT NULL DEFAULT 0')
      this.schema.raw('ALTER TABLE algo_positions MODIFY quantity INT NOT NULL')
    }
  }
}
