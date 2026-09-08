import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Delta-neutral funding-carry position (spot long + perp short).
 * dry_run rows are paper positions driven by live funding/price data.
 */
export default class CarryPosition extends BaseModel {
  public static table = 'carry_positions'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare symbol: string

  @column()
  declare dryRun: boolean

  @column()
  declare status: string

  @column()
  declare spotNotional: number | null

  @column()
  declare perpNotional: number | null

  @column()
  declare spotQuantity: number | null

  @column()
  declare perpQuantity: number | null

  @column()
  declare entrySpotPrice: number | null

  @column()
  declare entryPerpPrice: number | null

  @column()
  declare fundingReceivedUsd: number

  @column()
  declare basisUsd: number

  @column()
  declare spotPnlUsd: number

  @column()
  declare perpPnlUsd: number

  @column.dateTime()
  declare openedAt: DateTime | null

  @column.dateTime()
  declare lastRebalanceAt: DateTime | null

  @column.dateTime()
  declare lastFundingAt: DateTime | null

  @column.dateTime()
  declare haltedAt: DateTime | null

  @column()
  declare haltReason: string | null

  @column({
    prepare: (value: unknown) => JSON.stringify(value),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare meta: Record<string, any> | null
}