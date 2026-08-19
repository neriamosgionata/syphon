import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Article from './Article.js'
import Ticker from './Ticker.js'

export type SentimentLabel = 'very_bearish' | 'bearish' | 'neutral' | 'bullish' | 'very_bullish'

export default class Analysis extends BaseModel {
  public static table = 'analyses'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare articleId: number

  @column()
  declare tickerId: number

  @column()
  declare sentiment: SentimentLabel

  @column()
  declare sentimentScore: number

  @column()
  declare relevanceScore: number

  @column()
  declare confidence: number

  @column({
    prepare: (value: string[] | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | string[] | null) =>
      typeof value === 'string' ? JSON.parse(value) : value,
  })
  declare keywords: string[] | null

  @column()
  declare reasoning: string | null

  @column()
  declare tickerPriceAtAnalysis: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => Article)
  declare article: BelongsTo<typeof Article>

  @belongsTo(() => Ticker)
  declare ticker: BelongsTo<typeof Ticker>
}
