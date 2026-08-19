import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class AlgoConfig extends BaseModel {
  public static table = 'algo_configs'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare enabled: boolean

  @column()
  declare dryRun: boolean

  @column()
  declare broker: string

  @column()
  declare entryScoreThreshold: number

  @column()
  declare minConviction: number

  @column()
  declare minArticles: number

  @column({
    prepare: (value: string[]) => JSON.stringify(value),
    consume: (value: string) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare allowedRegimes: string[]

  @column()
  declare maxPositions: number

  @column()
  declare maxExposurePct: number

  @column()
  declare maxSinglePositionPct: number

  @column()
  declare dailyLossLimitPct: number

  @column()
  declare exitScoreThreshold: number

  @column()
  declare maxHoldingDays: number

  @column()
  declare orderType: string

  @column()
  declare timeInForce: string

  @column()
  declare cooldownMinutes: number

  @column({
    prepare: (value: string[]) => JSON.stringify(value),
    consume: (value: string) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare excludedSymbols: string[]

  @column.dateTime()
  declare lastRunAt: DateTime | null

  @column()
  declare disabledReason: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

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
