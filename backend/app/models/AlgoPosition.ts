import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Ticker from './Ticker.js'
import Trade from './Trade.js'

export type AlgoPositionStatus = 'open' | 'pending_entry' | 'closing' | 'closed'

export default class AlgoPosition extends BaseModel {
  public static table = 'algo_positions'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare tickerId: number

  @column()
  declare symbol: string

  @column()
  declare side: 'BUY' | 'SELL'

  @column()
  declare quantity: number

  @column()
  declare entryPrice: number

  @column()
  declare currentPrice: number | null

  @column()
  declare stopLoss: number

  @column()
  declare takeProfit: number

  @column()
  declare entryScore: number

  @column()
  declare entryConviction: number

  @column()
  declare entryRegime: string

  @column()
  declare entryReason: string

  @column()
  declare entryTradeId: number

  @column()
  declare exitTradeId: number | null

  @column()
  declare exitPrice: number | null

  @column()
  declare exitReason: string | null

  @column()
  declare realizedPnl: number | null

  @column()
  declare status: AlgoPositionStatus

  @column()
  declare forceClose: boolean

  @column.dateTime()
  declare openedAt: DateTime

  @column.dateTime()
  declare closedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => Ticker)
  declare ticker: BelongsTo<typeof Ticker>

  @belongsTo(() => Trade, { foreignKey: 'entryTradeId' })
  declare entryTrade: BelongsTo<typeof Trade>

  @belongsTo(() => Trade, { foreignKey: 'exitTradeId' })
  declare exitTrade: BelongsTo<typeof Trade>

  public get unrealizedPnl(): number | null {
    if (!this.currentPrice || !this.entryPrice) return null
    const direction = this.side === 'BUY' ? 1 : -1
    return (this.currentPrice - this.entryPrice) * this.quantity * direction
  }

  public get unrealizedPnlPct(): number | null {
    if (!this.currentPrice || !this.entryPrice) return null
    const direction = this.side === 'BUY' ? 1 : -1
    return ((this.currentPrice - this.entryPrice) / this.entryPrice) * direction
  }

  public get daysHeld(): number {
    const end = this.closedAt || DateTime.now()
    return Math.floor(end.diff(this.openedAt, 'days').days)
  }
}
