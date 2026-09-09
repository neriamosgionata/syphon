import { DateTime } from 'luxon'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import Article from './Article.js'

export default class ScrapeSource extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare slug: string

  @column()
  declare type: 'rss' | 'html' | 'api'

  @column()
  declare url: string

  /** Source category: 'crypto' | 'markets' | 'macro'. */
  @column()
  declare category: string

  @column({
    prepare: (value: any) => (value ? JSON.stringify(value) : null),
    consume: (value: any) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare config: Record<string, any> | null

  @column()
  declare isActive: boolean

  @column.dateTime()
  declare lastScrapedAt: DateTime | null

  @column()
  declare errorCount: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Article)
  declare articles: HasMany<typeof Article>
}
