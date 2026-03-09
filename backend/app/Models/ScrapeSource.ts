import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, HasMany } from '@ioc:Adonis/Lucid/Orm'
import Article from './Article'

export default class ScrapeSource extends BaseModel {
  @column({ isPrimary: true })
  public id: number

  @column()
  public name: string

  @column()
  public slug: string

  @column()
  public type: 'rss' | 'html' | 'api'

  @column()
  public url: string

  @column()
  public config: Record<string, any> | null

  @column()
  public isActive: boolean

  @column.dateTime()
  public lastScrapedAt: DateTime | null

  @column()
  public errorCount: number

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  @hasMany(() => Article)
  public articles: HasMany<typeof Article>
}
