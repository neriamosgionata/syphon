import BaseSchema from "@ioc:Adonis/Lucid/Schema";

export default class extends BaseSchema {
  protected tableName = "ticker_charts";

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments("id");

      table.string("ticker").notNullable();

      table.datetime("date").notNullable();

      table.bigInteger("volume").nullable();
      table.float("open").nullable();
      table.float("low").nullable();
      table.float("close").nullable();
      table.float("adjclose").nullable();

      table.enum("interval", [
        "1m",
        "2m",
        "5m",
        "15m",
        "30m",
        "60m",
        "90m",
        "1h",
        "1d",
        "5d",
        "1wk",
        "1mo",
        "3mo"
      ]).defaultTo("1d");

      table.timestamp("created_at", { useTz: true });
      table.timestamp("updated_at", { useTz: true });

      table.index(["date"], "date_idx");
      table.index(["ticker"], "ticker_idx");
    });
  }

  public async down() {
    this.schema.dropTable(this.tableName);
  }
}
