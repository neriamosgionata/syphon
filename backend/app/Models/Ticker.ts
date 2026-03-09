import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, HasMany } from '@ioc:Adonis/Lucid/Orm'
import Analysis from './Analysis'
import TickerSnapshot from './TickerSnapshot'
import Trade from './Trade'

export default class Ticker extends BaseModel {
  @column({ isPrimary: true })
  public id: number

  @column()
  public symbol: string

  @column()
  public name: string

  @column()
  public exchange: string | null

  @column()
  public sector: string | null

  @column()
  public industry: string | null

  @column()
  public currentPrice: number | null

  @column()
  public marketCap: number | null

  @column()
  public metadata: Record<string, any> | null

  @column()
  public isActive: boolean

  @column.dateTime()
  public lastFetchedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  @hasMany(() => Analysis)
  public analyses: HasMany<typeof Analysis>

  @hasMany(() => TickerSnapshot)
  public snapshots: HasMany<typeof TickerSnapshot>

  @hasMany(() => Trade)
  public trades: HasMany<typeof Trade>
}
