import { BaseSchema } from '@adonisjs/lucid/schema'

export default class NewsIntegration extends BaseSchema {
  public async up() {
    this.schema.alterTable('algo_configs', (table) => {
      // News-sentiment entry gate: block entries while the recency-weighted
      // news sentiment for the symbol sits below the threshold AND at least
      // `fast_news_min_articles` distinct events occurred in the window.
      // 0/off = news never blocks (algo runs price-blind, as before).
      table.boolean('fast_news_gate_enabled').defaultTo(false)
      table.decimal('fast_news_min_sentiment', 6, 4).defaultTo(0)
      table.integer('fast_news_min_articles').defaultTo(3)
      table.integer('fast_news_window_hours').defaultTo(24)
    })

    this.schema.alterTable('scrape_sources', (table) => {
      // Source category: 'crypto' | 'markets' | 'macro'. Used for source
      // weighting and UI filtering. Default 'markets' (existing rows).
      table.string('category', 50).defaultTo('markets')
    })
  }

  public async down() {
    this.schema.alterTable('algo_configs', (table) => {
      table.dropColumns(
        'fast_news_gate_enabled', 'fast_news_min_sentiment',
        'fast_news_min_articles', 'fast_news_window_hours'
      )
    })
    this.schema.alterTable('scrape_sources', (table) => {
      table.dropColumn('category')
    })
  }
}