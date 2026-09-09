import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Ticker from './Ticker.js'
import Analysis from './Analysis.js'

export type Broker = 'ibkr' | 'kraken'
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
  declare id: number

  @column()
  declare tickerId: number

  @column()
  declare symbol: string

  @column()
  declare side: TradeSide

  @column()
  declare orderType: OrderType

  @column()
  declare quantity: number

  @column()
  declare limitPrice: number | null

  @column()
  declare stopPrice: number | null

  @column()
  declare trailAmount: number | null

  @column()
  declare timeInForce: string

  @column()
  declare ibOrderId: number | null

  @column()
  declare ibPermId: string | null

  @column()
  declare externalOrderId: string | null

  @column()
  declare clientOrderId: string | null

  @column()
  declare status: TradeStatus

  @column()
  declare fillPrice: number | null

  @column()
  declare filledQuantity: number

  @column()
  declare commission: number | null

  @column()
  declare realizedPnl: number | null

  @column()
  declare errorMessage: string | null

  @column()
  declare exchange: string

  @column()
  declare currency: string

  @column()
  declare broker: Broker

  @column({
    prepare: (value: any) => (value ? JSON.stringify(value) : null),
    consume: (value: any) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare ibMetadata: Record<string, any> | null

  @column()
  declare analysisId: number | null

  @column.dateTime()
  declare submittedAt: DateTime | null

  @column.dateTime()
  declare filledAt: DateTime | null

  @column.dateTime()
  declare cancelledAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => Ticker)
  declare ticker: BelongsTo<typeof Ticker>

  @belongsTo(() => Analysis)
  declare analysis: BelongsTo<typeof Analysis>
}
