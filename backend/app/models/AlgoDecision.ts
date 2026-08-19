import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Ticker from './Ticker.js'
import Trade from './Trade.js'
import AlgoPosition from './AlgoPosition.js'

export type DecisionType = 'enter' | 'exit' | 'hold' | 'skip'

export default class AlgoDecision extends BaseModel {
  public static table = 'algo_decisions'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare runId: string

  @column()
  declare symbol: string

  @column()
  declare tickerId: number

  @column()
  declare decision: DecisionType

  @column()
  declare reason: string

  @column()
  declare side: 'BUY' | 'SELL' | null

  @column()
  declare quantity: number | null

  @column()
  declare compositeScore: number | null

  @column()
  declare conviction: number | null

  @column()
  declare regime: string | null

  @column()
  declare positionSizePct: number | null

  @column()
  declare stopLoss: number | null

  @column()
  declare takeProfit: number | null

  @column()
  declare tradeId: number | null

  @column()
  declare algoPositionId: number | null

  @column({
    prepare: (value: any) => (value ? JSON.stringify(value) : null),
    consume: (value: string) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare context: Record<string, any> | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => Ticker)
  declare ticker: BelongsTo<typeof Ticker>

  @belongsTo(() => Trade)
  declare trade: BelongsTo<typeof Trade>

  @belongsTo(() => AlgoPosition)
  declare algoPosition: BelongsTo<typeof AlgoPosition>
}
