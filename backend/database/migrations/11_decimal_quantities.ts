import BaseSchema from '@ioc:Adonis/Lucid/Schema'

/**
 * Crypto pairs trade in fractional units (e.g. 0.5 BTC). INTEGER columns
 * silently truncated fractional quantities, corrupting fills and P&L.
 */
export default class DecimalQuantities extends BaseSchema {
  public async up() {
    this.schema.raw('ALTER TABLE trades MODIFY quantity DECIMAL(18,8) NOT NULL')
    this.schema.raw('ALTER TABLE trades MODIFY filled_quantity DECIMAL(18,8) NOT NULL DEFAULT 0')
    this.schema.raw('ALTER TABLE algo_positions MODIFY quantity DECIMAL(18,8) NOT NULL')
  }

  public async down() {
    this.schema.raw('ALTER TABLE trades MODIFY quantity INT NOT NULL')
    this.schema.raw('ALTER TABLE trades MODIFY filled_quantity INT NOT NULL DEFAULT 0')
    this.schema.raw('ALTER TABLE algo_positions MODIFY quantity INT NOT NULL')
  }
}
