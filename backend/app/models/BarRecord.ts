import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * One OHLCV bar for intervals >= 60s. Unique per symbol + interval + open
 * time; written by BarRecorderService, read by the trend evaluator and the
 * `bar_records` backtest source.
 */
export default class BarRecord extends BaseModel {
  public static table = 'bar_records'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare symbol: string

  @column()
  declare intervalSeconds: number

  /** Bar open time, epoch ms. */
  @column()
  declare ts: number

  @column()
  declare open: number

  @column()
  declare high: number

  @column()
  declare low: number

  @column()
  declare close: number

  @column()
  declare volume: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
