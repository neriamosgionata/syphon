import { DateTime } from 'luxon'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import Analysis from './Analysis.js'
import TickerSnapshot from './TickerSnapshot.js'
import Trade from './Trade.js'

export default class Ticker extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare symbol: string

  @column()
  declare name: string

  @column()
  declare exchange: string | null

  /** Instrument class: crypto | stock | etf | index | fund | future. */
  @column()
  declare secType: string

  @column()
  declare currency: string

  /** Minimum orderable quantity (venue lot size). Null = unknown. */
  @column()
  declare minQty: number | null

  /** Quantity increment for orders. Null = unknown. */
  @column()
  declare qtyStep: number | null

  @column()
  declare sector: string | null

  @column()
  declare industry: string | null

  @column()
  declare currentPrice: number | null

  @column()
  declare marketCap: number | null

  @column({
    prepare: (value: any) => (value ? JSON.stringify(value) : null),
    consume: (value: any) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare metadata: Record<string, any> | null

  @column()
  declare isActive: boolean

  @column.dateTime()
  declare lastFetchedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Analysis)
  declare analyses: HasMany<typeof Analysis>

  @hasMany(() => TickerSnapshot)
  declare snapshots: HasMany<typeof TickerSnapshot>

  @hasMany(() => Trade)
  declare trades: HasMany<typeof Trade>
}
