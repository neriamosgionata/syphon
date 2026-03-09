import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, BelongsTo } from '@ioc:Adonis/Lucid/Orm'
import Article from './Article'
import Ticker from './Ticker'

export type SentimentLabel = 'very_bearish' | 'bearish' | 'neutral' | 'bullish' | 'very_bullish'

export default class Analysis extends BaseModel {
  public static table = 'analyses'

  @column({ isPrimary: true })
  public id: number

  @column()
  public articleId: number

  @column()
  public tickerId: number

  @column()
  public sentiment: SentimentLabel

  @column()
  public sentimentScore: number

  @column()
  public relevanceScore: number

  @column()
  public confidence: number

  @column({
    prepare: (value: string[] | null) => (value ? JSON.stringify(value) : null),
    consume: (value: string | string[] | null) =>
      typeof value === 'string' ? JSON.parse(value) : value,
  })
  public keywords: string[] | null

  @column()
  public reasoning: string | null

  @column()
  public tickerPriceAtAnalysis: number | null

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  @belongsTo(() => Article)
  public article: BelongsTo<typeof Article>

  @belongsTo(() => Ticker)
  public ticker: BelongsTo<typeof Ticker>
}
