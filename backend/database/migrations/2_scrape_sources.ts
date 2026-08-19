import { BaseSchema } from '@adonisjs/lucid/schema'

export default class ScrapeSources extends BaseSchema {
  protected tableName = 'scrape_sources'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('name', 100).notNullable()
      table.string('slug', 100).notNullable().unique()
      table.enum('type', ['rss', 'html', 'api']).notNullable()
      table.string('url', 500).notNullable()
      table.json('config').nullable()
      table.boolean('is_active').defaultTo(true)
      table.timestamp('last_scraped_at').nullable()
      table.integer('error_count').defaultTo(0)
      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
