import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Ticker from './Ticker.js'

export default class TickerSnapshot extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare tickerId: number

  @column()
  declare open: number | null

  @column()
  declare high: number | null

  @column()
  declare low: number | null

  @column()
  declare close: number | null

  @column()
  declare volume: number | null

  @column()
  declare changePercent: number | null

  @column()
  declare date: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => Ticker)
  declare ticker: BelongsTo<typeof Ticker>
}
