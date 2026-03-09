import BaseSchema from '@ioc:Adonis/Lucid/Schema'

export default class Articles extends BaseSchema {
  protected tableName = 'articles'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('external_id', 255).nullable().unique()
      table.string('title', 500).notNullable()
      table.text('summary').nullable()
      table.text('content').nullable()
      table.string('url', 1000).notNullable()
      table.string('source_name', 100).notNullable()
      table.integer('scrape_source_id').unsigned().nullable().references('id').inTable('scrape_sources').onDelete('SET NULL')
      table.string('author', 255).nullable()
      table.string('image_url', 1000).nullable()
      table.timestamp('published_at').nullable()
      table.boolean('is_analyzed').defaultTo(false)
      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })

      table.index(['source_name', 'published_at'])
      table.index(['is_analyzed'])
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
