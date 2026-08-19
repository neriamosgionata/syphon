import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, belongsTo } from '@adonisjs/lucid/orm'
import type { HasMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import Analysis from './Analysis.js'
import ScrapeSource from './ScrapeSource.js'

export default class Article extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare externalId: string | null

  @column()
  declare title: string

  @column()
  declare summary: string | null

  @column()
  declare content: string | null

  @column()
  declare url: string

  @column()
  declare sourceName: string

  @column()
  declare scrapeSourceId: number | null

  @column()
  declare author: string | null

  @column()
  declare imageUrl: string | null

  @column.dateTime()
  declare publishedAt: DateTime | null

  @column()
  declare isAnalyzed: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Analysis)
  declare analyses: HasMany<typeof Analysis>

  @belongsTo(() => ScrapeSource)
  declare scrapeSource: BelongsTo<typeof ScrapeSource>
}
