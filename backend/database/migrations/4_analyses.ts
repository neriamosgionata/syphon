import { BaseSchema } from '@adonisjs/lucid/schema'

export default class Analyses extends BaseSchema {
  protected tableName = 'analyses'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.integer('article_id').unsigned().notNullable().references('id').inTable('articles').onDelete('CASCADE')
      table.integer('ticker_id').unsigned().notNullable().references('id').inTable('tickers').onDelete('CASCADE')
      table.enum('sentiment', ['very_bearish', 'bearish', 'neutral', 'bullish', 'very_bullish']).notNullable()
      table.decimal('sentiment_score', 5, 4).notNullable()
      table.decimal('relevance_score', 5, 4).notNullable()
      table.decimal('confidence', 5, 4).notNullable()
      table.json('keywords').nullable()
      table.text('reasoning').nullable()
      table.decimal('ticker_price_at_analysis', 12, 4).nullable()
      table.timestamp('created_at', { useTz: true })
      table.timestamp('updated_at', { useTz: true })

      table.unique(['article_id', 'ticker_id'])
      table.index(['ticker_id', 'created_at'])
      table.index(['sentiment'])
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
