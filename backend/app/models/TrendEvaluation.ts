import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Append-only trend evaluation / certification snapshot. Reports render
 * from the stored config snapshot, never from the live config row, so a
 * later config edit cannot rewrite history (R9).
 */
export default class TrendEvaluation extends BaseModel {
  public static table = 'trend_evaluations'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare symbol: string

  @column()
  declare intervalSeconds: number

  @column()
  declare windowStart: number | null

  @column()
  declare windowEnd: number | null

  @column()
  declare bars: number | null

  @column()
  declare equity: number | null

  @column()
  declare netReturnPct: number | null

  @column()
  declare maxDrawdownPct: number | null

  @column()
  declare profitFactor: number | null

  @column()
  declare greenMonths: number | null

  @column()
  declare tradeCount: number | null

  /** certified | research | paper | provisional | halted */
  @column()
  declare state: string

  @column({ consume: (value: unknown) => Boolean(value) })
  declare provisional: boolean

  @column({ consume: (value: unknown) => Boolean(value) })
  declare coverageOk: boolean

  @column()
  declare configHash: string | null

  @column({
    prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare configSnapshot: Record<string, any> | null

  @column({
    prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare monthly: any[] | null

  @column({
    prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare quarterly: any[] | null
}
