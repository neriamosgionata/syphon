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

  // Intraminute fast mode (Kraken fast engine)
  @column()
  declare fastEnabled: boolean

  @column()
  declare fastIntervalSeconds: number

  @column({
    prepare: (value: string[] | null) => (value && value.length ? JSON.stringify(value) : null),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : ['BTC', 'ETH', 'SOL']),
  })
  declare fastWatchlist: string[]

  @column()
  declare fastMomentumSeconds: number

  @column()
  declare fastMomentumThresholdPct: number

  @column()
  declare fastRsiLow: number

  @column()
  declare fastRsiHigh: number

  @column()
  declare fastStopLossPct: number

  @column()
  declare fastTakeProfitPct: number

  @column()
  declare fastExitReversalPct: number

  @column()
  declare fastCooldownSeconds: number

  // Fast strategy controls (migration 14)
  @column()
  declare fastTrailingStopPct: number

  @column()
  declare fastTrailingActivatePct: number

  @column()
  declare fastMaxHoldSeconds: number

  @column()
  declare fastEmaPeriod: number

  @column()
  declare fastVolatilityWindowSeconds: number

  @column()
  declare fastVolatilityMult: number

  @column()
  declare fastVolatilityFloorPct: number

  @column()
  declare fastVolatilityCeilingPct: number

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
      fastEnabled: false,
      fastIntervalSeconds: 10,
      fastWatchlist: ['BTC', 'ETH', 'SOL'],
      fastMomentumSeconds: 60,
      fastMomentumThresholdPct: 0.15,
      fastRsiLow: 35,
      fastRsiHigh: 75,
      fastStopLossPct: 0.5,
      fastTakeProfitPct: 1.0,
      fastExitReversalPct: -0.3,
      fastCooldownSeconds: 180,
      fastTrailingStopPct: 0.3,
      fastTrailingActivatePct: 0.4,
      fastMaxHoldSeconds: 1800,
      fastEmaPeriod: 20,
      fastVolatilityWindowSeconds: 60,
      fastVolatilityMult: 2.0,
      fastVolatilityFloorPct: 0.05,
      fastVolatilityCeilingPct: 0,
      lastRunAt: null,
      disabledReason: null,
    })
  }
}
