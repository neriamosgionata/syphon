import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, BelongsTo } from '@ioc:Adonis/Lucid/Orm'
import Ticker from './Ticker'
import Analysis from './Analysis'

export type Broker = 'ibkr' | 'kraken' | 'binance'
export type TradeSide = 'BUY' | 'SELL'
export type OrderType = 'MKT' | 'LMT' | 'STP' | 'STP_LMT' | 'TRAIL'
export type TradeStatus =
  | 'pending'
  | 'submitted'
  | 'pre_submitted'
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'error'
  | 'inactive'

export default class Trade extends BaseModel {
  @column({ isPrimary: true })
  public id: number

  @column()
  public tickerId: number

  @column()
  public symbol: string

  @column()
  public side: TradeSide

  @column()
  public orderType: OrderType

  @column()
  public quantity: number

  @column()
  public limitPrice: number | null

  @column()
  public stopPrice: number | null

  @column()
  public trailAmount: number | null

  @column()
  public timeInForce: string

  @column()
  public ibOrderId: number | null

  @column()
  public ibPermId: string | null

  @column()
  public externalOrderId: string | null

  @column()
  public status: TradeStatus

  @column()
  public fillPrice: number | null

  @column()
  public filledQuantity: number

  @column()
  public commission: number | null

  @column()
  public realizedPnl: number | null

  @column()
  public errorMessage: string | null

  @column()
  public exchange: string

  @column()
  public currency: string

  @column()
  public broker: Broker

  @column({
    prepare: (value: any) => (value ? JSON.stringify(value) : null),
    consume: (value: any) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  public ibMetadata: Record<string, any> | null

  @column()
  public analysisId: number | null

  @column.dateTime()
  public submittedAt: DateTime | null

  @column.dateTime()
  public filledAt: DateTime | null

  @column.dateTime()
  public cancelledAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  @belongsTo(() => Ticker)
  public ticker: BelongsTo<typeof Ticker>

  @belongsTo(() => Analysis)
  public analysis: BelongsTo<typeof Analysis>
}
