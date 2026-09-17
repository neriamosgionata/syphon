import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * One row per Kraken Earn strategy the account is eligible for.
 * Amounts are native asset units; the venue reports minimums and caps in USD.
 */
export default class YieldAllocation extends BaseModel {
  public static table = 'yield_allocations'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare strategyId: string

  @column()
  declare asset: string

  @column()
  declare lockType: string

  @column({ consume: (value: unknown) => Boolean(value) })
  declare canAllocate: boolean

  @column()
  declare autoCompound: string | null

  @column()
  declare allocatedNative: number

  @column()
  declare pendingNative: number

  @column()
  declare unbondingNative: number

  @column()
  declare exitQueueNative: number

  @column()
  declare totalRewardedNative: number

  @column()
  declare baselineRewardedNative: number

  @column()
  declare unbondingSeconds: number | null

  @column()
  declare minAllocationUsd: number | null

  @column()
  declare userCapUsd: number | null

  @column()
  declare apyLow: number | null

  @column()
  declare apyHigh: number | null

  @column()
  declare baselineAt: number | null

  @column()
  declare lastRefreshedAt: number | null
}
