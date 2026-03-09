import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, HasMany, belongsTo, BelongsTo } from '@ioc:Adonis/Lucid/Orm'
import Analysis from './Analysis'
import ScrapeSource from './ScrapeSource'

export default class Article extends BaseModel {
  @column({ isPrimary: true })
  public id: number

  @column()
  public externalId: string | null

  @column()
  public title: string

  @column()
  public summary: string | null

  @column()
  public content: string | null

  @column()
  public url: string

  @column()
  public sourceName: string

  @column()
  public scrapeSourceId: number | null

  @column()
  public author: string | null

  @column()
  public imageUrl: string | null

  @column.dateTime()
  public publishedAt: DateTime | null

  @column()
  public isAnalyzed: boolean

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  @hasMany(() => Analysis)
  public analyses: HasMany<typeof Analysis>

  @belongsTo(() => ScrapeSource)
  public scrapeSource: BelongsTo<typeof ScrapeSource>
}
