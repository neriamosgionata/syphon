import BaseSchema from '@ioc:Adonis/Lucid/Schema'

export default class extends BaseSchema {
  protected tableName = 'ticker_charts';

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.float("high").nullable().after("low");
    });
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn("high");
    });
  }
}
