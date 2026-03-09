import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, BelongsTo } from '@ioc:Adonis/Lucid/Orm'
import Ticker from './Ticker'

export default class TickerSnapshot extends BaseModel {
  @column({ isPrimary: true })
  public id: number

  @column()
  public tickerId: number

  @column()
  public open: number | null

  @column()
  public high: number | null

  @column()
  public low: number | null

  @column()
  public close: number | null

  @column()
  public volume: number | null

  @column()
  public changePercent: number | null

  @column()
  public date: string

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @belongsTo(() => Ticker)
  public ticker: BelongsTo<typeof Ticker>
}
