import { DateTime } from 'luxon'
import { BaseModel, column } from '@ioc:Adonis/Lucid/Orm'

export default class AlgoConfig extends BaseModel {
  public static table = 'algo_configs'

  @column({ isPrimary: true })
  public id: number

  @column()
  public enabled: boolean

  @column()
  public dryRun: boolean

  @column()
  public broker: string

  @column()
  public entryScoreThreshold: number

  @column()
  public minConviction: number

  @column()
  public minArticles: number

  @column({
    prepare: (value: string[]) => JSON.stringify(value),
    consume: (value: string) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  public allowedRegimes: string[]

  @column()
  public maxPositions: number

  @column()
  public maxExposurePct: number

  @column()
  public maxSinglePositionPct: number

  @column()
  public dailyLossLimitPct: number

  @column()
  public exitScoreThreshold: number

  @column()
  public maxHoldingDays: number

  @column()
  public orderType: string

  @column()
  public timeInForce: string

  @column()
  public cooldownMinutes: number

  @column({
    prepare: (value: string[]) => JSON.stringify(value),
    consume: (value: string) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  public excludedSymbols: string[]

  @column.dateTime()
  public lastRunAt: DateTime | null

  @column()
  public disabledReason: string | null

  @column.dateTime({ autoCreate: true })
  public createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  public updatedAt: DateTime

  public static async getConfig(): Promise<AlgoConfig> {
    const config = await AlgoConfig.find(1)
    if (!config) {
      return AlgoConfig.ensureDefault()
    }
    return config
  }

  public static async ensureDefault(): Promise<AlgoConfig> {
    const existing = await AlgoConfig.find(1)
    if (existing) return existing

    return AlgoConfig.create({
      enabled: false,
      dryRun: true,
      broker: 'ibkr',
      entryScoreThreshold: 30,
      minConviction: 0.40,
      minArticles: 1,
      allowedRegimes: ['trending_up', 'ranging'],
      maxPositions: 10,
      maxExposurePct: 0.80,
      maxSinglePositionPct: 0.15,
      dailyLossLimitPct: 0.03,
      exitScoreThreshold: -10,
      maxHoldingDays: 30,
      orderType: 'MKT',
      timeInForce: 'DAY',
      cooldownMinutes: 5,
      excludedSymbols: [],
      lastRunAt: null,
      disabledReason: null,
    })
  }
}
