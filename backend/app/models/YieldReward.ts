import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * One row per Kraken ledger reward event. `refid` is the venue's booking id
 * and makes ingestion idempotent; `time` is the venue settlement time in
 * epoch milliseconds, which avoids date-format ambiguity in comparisons.
 */
export default class YieldReward extends BaseModel {
  public static table = 'yield_rewards'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare refid: string

  @column()
  declare time: number

  @column()
  declare ledgerType: string

  @column()
  declare subtype: string | null

  @column()
  declare asset: string

  @column()
  declare amount: number

  @column()
  declare balanceAfter: number | null

  @column()
  declare strategyId: string | null
}
