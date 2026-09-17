import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Single-row frozen trend configuration (KTD7). Strategy fields are stored
 * in FastStrategy SAMPLE units for a 5m cadence; percent-style engine
 * fields are stored as percentages and converted by the mapper.
 */
export default class TrendConfig extends BaseModel {
  public static table = 'trend_configs'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column({ consume: (value: unknown) => Boolean(value) })
  declare trendMode: boolean

  @column()
  declare emaPeriod: number

  @column()
  declare trendSlopePct: number | null

  @column()
  declare trendSlopeWindowSeconds: number | null

  @column()
  declare regimeEmaPeriod: number | null

  @column()
  declare regimeSlopeWindowSeconds: number | null

  @column()
  declare regimeSlopeMinPct: number | null

  @column()
  declare efficiencyWindowDays: number | null

  @column()
  declare efficiencyMinPct: number | null

  @column()
  declare efficiencyExitPct: number | null

  @column()
  declare stopLossPct: number | null

  @column()
  declare takeProfitPct: number | null

  @column()
  declare exitReversalPct: number | null

  @column()
  declare trailingStopPct: number | null

  @column()
  declare trailingActivatePct: number | null

  @column()
  declare cooldownSeconds: number | null

  @column()
  declare maxHoldSeconds: number | null

  @column()
  declare loopIntervalSeconds: number | null

  @column()
  declare capitalPerAssetUsd: number | null

  @column()
  declare takerFeePct: number | null

  @column()
  declare slippageBps: number | null

  @column()
  declare maxPositions: number | null

  @column()
  declare maxExposurePct: number | null

  @column()
  declare maxSinglePositionPct: number | null

  @column({
    prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare extras: Record<string, any> | null

  @column()
  declare configHash: string | null
}
