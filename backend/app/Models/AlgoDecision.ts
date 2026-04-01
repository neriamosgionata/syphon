import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, BelongsTo } from '@ioc:Adonis/Lucid/Orm'
import Ticker from './Ticker'
import Trade from './Trade'
import AlgoPosition from './AlgoPosition'

export type DecisionType = 'enter' | 'exit' | 'hold' | 'skip'

export default class AlgoDecision extends BaseModel {
  public static table = 'algo_decisions'

  @column({ isPrimary: true })
  public id: number

  @column()
  public runId: string

  @column()
  public symbol: string

  @column()
  public tickerId: number

  @column()
  public decision: DecisionType

  @column()
  public reason: string

  @column()
  public side: 'BUY' | 'SELL' | null

  @column()
  public quantity: number | null

  @column()
  public compositeScore: number | null

  @column()
  public conviction: number | null

  @column()
  public regime: string | null

  @column()
  public positionSizePct: number | null

  @column()
  public stopLoss: number | null

  @column()
  public takeProfit: number | null

  @column()
  public tradeId: number | null

  @column()
  public algoPositionId: number | null

  @column({
    prepare: (value: any) => (value ? JSON.stringify(value) : null),
    consume: (value: string) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  public context: Record<string, any> | null

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @belongsTo(() => Ticker)
  public ticker: BelongsTo<typeof Ticker>

  @belongsTo(() => Trade)
  public trade: BelongsTo<typeof Trade>

  @belongsTo(() => AlgoPosition)
  public algoPosition: BelongsTo<typeof AlgoPosition>
}
