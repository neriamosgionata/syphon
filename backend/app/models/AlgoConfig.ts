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

  // Trend-rider mode (migration 15)
  @column()
  declare fastTrendMode: boolean

  @column()
  declare fastTrendSlopePct: number

  @column()
  declare fastTrendSlopeWindowSeconds: number

  // Regime + volume gates (migration 16)
  @column()
  declare fastRegimeEmaPeriod: number

  @column()
  declare fastRegimeSlopeWindowSeconds: number

  @column()
  declare fastRegimeSlopeMinPct: number

  @column()
  declare fastVolumeWindowSeconds: number

  @column()
  declare fastVolumeMinRatio: number

  // Execution + vol targeting (migration 18)
  @column()
  declare fastMakerExecution: boolean

  @column()
  declare fastLimitFillSeconds: number

  @column()
  declare fastLimitOffsetPct: number

  @column()
  declare fastMakerFeePct: number

  @column()
  declare fastVolTargetPct: number

  @column()
  declare fastVolTargetWindowSeconds: number

  @column()
  declare fastVolTargetMaxMult: number

  // Signal upgrades + execution realism (migration 19)
  @column()
  declare fastHarVolForecast: boolean

  @column()
  declare fastCusumWindowSeconds: number

  @column()
  declare fastCusumExitPct: number

  @column()
  declare fastJumpSlackPct: number

  @column()
  declare fastChoppinessPeriod: number

  @column()
  declare fastChoppinessMax: number

  @column()
  declare fastTradeStartUtc: number

  @column()
  declare fastTradeEndUtc: number

  @column()
  declare fastConvictionSizing: boolean

  @column()
  declare fastSlippageBps: number

  // Safety rails + exit quality (migration 17)
  @column()
  declare fastCorrelatedExposurePct: number

  @column()
  declare fastRiskPerTradePct: number

  @column()
  declare fastMaxLossStreak: number

  @column()
  declare fastLossStreakPauseSeconds: number

  @column()
  declare fastTrailingVolatilityMult: number

  @column()
  declare fastScaleOutPct: number

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
      fastTrendMode: false,
      fastTrendSlopePct: 0.05,
      fastTrendSlopeWindowSeconds: 1800,
      fastRegimeEmaPeriod: 0,
      fastRegimeSlopeWindowSeconds: 3600,
      fastRegimeSlopeMinPct: 0.02,
      fastVolumeWindowSeconds: 300,
      fastVolumeMinRatio: 0,
      fastMakerExecution: false,
      fastLimitFillSeconds: 15,
      fastLimitOffsetPct: 0.05,
      fastMakerFeePct: 0.0016,
      fastVolTargetPct: 0,
      fastVolTargetWindowSeconds: 3600,
      fastVolTargetMaxMult: 2,
      fastHarVolForecast: false,
      fastCusumWindowSeconds: 0,
      fastCusumExitPct: 0,
      fastJumpSlackPct: 0,
      fastChoppinessPeriod: 0,
      fastChoppinessMax: 0,
      fastTradeStartUtc: 0,
      fastTradeEndUtc: 24,
      fastConvictionSizing: false,
      fastSlippageBps: 0,
      fastCorrelatedExposurePct: 0,
      fastRiskPerTradePct: 0,
      fastMaxLossStreak: 0,
      fastLossStreakPauseSeconds: 0,
      fastTrailingVolatilityMult: 0,
      fastScaleOutPct: 0,
      lastRunAt: null,
      disabledReason: null,
    })
  }
}
