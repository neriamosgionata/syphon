import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, BelongsTo } from '@ioc:Adonis/Lucid/Orm'
import Ticker from './Ticker'
import Trade from './Trade'

export type AlgoPositionStatus = 'open' | 'closing' | 'closed'

export default class AlgoPosition extends BaseModel {
  public static table = 'algo_positions'

  @column({ isPrimary: true })
  public id: number

  @column()
  public tickerId: number

  @column()
  public symbol: string

  @column()
  public side: 'BUY' | 'SELL'

  @column()
  public quantity: number

  @column()
  public entryPrice: number

  @column()
  public currentPrice: number | null

  @column()
  public stopLoss: number

  @column()
  public takeProfit: number

  @column()
  public entryScore: number

  @column()
  public entryConviction: number

  @column()
  public entryRegime: string

  @column()
  public entryReason: string

  @column()
  public entryTradeId: number

  @column()
  public exitTradeId: number | null

  @column()
  public exitPrice: number | null

  @column()
  public exitReason: string | null

  @column()
  public realizedPnl: number | null

  @column()
  public status: AlgoPositionStatus

  @column()
  public forceClose: boolean

  @column.dateTime()
  public openedAt: DateTime

  @column.dateTime()
  public closedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  @belongsTo(() => Ticker)
  public ticker: BelongsTo<typeof Ticker>

  @belongsTo(() => Trade, { foreignKey: 'entryTradeId' })
  public entryTrade: BelongsTo<typeof Trade>

  @belongsTo(() => Trade, { foreignKey: 'exitTradeId' })
  public exitTrade: BelongsTo<typeof Trade>

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
