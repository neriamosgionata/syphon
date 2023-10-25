import BaseSchema from "@ioc:Adonis/Lucid/Schema";

export default class extends BaseSchema {
  protected tableName = "jobs";

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string("id").primary();

      table.string("name").notNullable();

      table.integer("status").notNullable();

      table.json("parameters").nullable();

      table.text("tags").nullable();

      table.text("error").nullable();
      table.text("error_stack").nullable();

      table.dateTime("started_at").nullable();
      table.dateTime("finished_at").nullable();

      /**
       * Uses timestamptz for PostgreSQL and DATETIME2 for MSSQL
       */
      table.timestamp("created_at", {useTz: true});
      table.timestamp("updated_at", {useTz: true});

    });
  }

  public async down() {
    this.schema.dropTable(this.tableName);
  }
}
