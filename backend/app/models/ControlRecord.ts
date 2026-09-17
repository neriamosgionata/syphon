import db from '@adonisjs/lucid/services/db'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Scheduler locks, heartbeats, and latching trip state (KTD10). Locks are
 * compare-and-set updates on a leased row: a held lease denies a second
 * tick; an expired lease is adoptable. Status reads `isStale` to detect a
 * missed heartbeat.
 */
export default class ControlRecord extends BaseModel {
  public static table = 'control'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare owner: string | null

  @column()
  declare state: string | null

  @column()
  declare leaseExpiresAt: number | null

  @column()
  declare heartbeatAt: number | null

  @column({
    prepare: (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value)),
    consume: (value: string | null) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare detail: Record<string, any> | null

  /** Create the row when absent (migrations do not seed dialect-specific SQL). */
  public static async ensure(name: string): Promise<void> {
    const existing = await ControlRecord.query().where('name', name).first()
    if (!existing) {
      await ControlRecord.create({ name, owner: null, state: null, leaseExpiresAt: null, heartbeatAt: null })
    }
  }

  public static async get(name: string): Promise<ControlRecord | null> {
    return ControlRecord.query().where('name', name).first()
  }

  /** Acquire the lease if free or expired. Denies when another owner holds it. */
  public static async tryAcquire(name: string, owner: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    await ControlRecord.ensure(name)
    const updated = await db
      .from('control')
      .where('name', name)
      .andWhere((query) => query.whereNull('lease_expires_at').orWhere('lease_expires_at', '<', now))
      .update({ owner, lease_expires_at: now + ttlMs, heartbeat_at: now })
    return Number(updated) > 0
  }

  public static async heartbeat(name: string, owner: string, now = Date.now(), detail?: Record<string, any>): Promise<void> {
    const patch: Record<string, any> = { heartbeat_at: now }
    if (detail !== undefined) patch.detail = JSON.stringify(detail)
    await db.from('control').where('name', name).where('owner', owner).update(patch)
  }

  public static async release(name: string, owner: string): Promise<void> {
    await db
      .from('control')
      .where('name', name)
      .where('owner', owner)
      .update({ owner: null, lease_expires_at: null })
  }

  /** Set the row's latch state (and optional detail/heartbeat) in one place. */
  public static async setState(
    name: string,
    state: string,
    detail: Record<string, any> | null = null,
    options: { heartbeatAt?: number } = {}
  ): Promise<void> {
    await ControlRecord.ensure(name)
    const patch: Record<string, any> = {
      state,
      detail: detail === null ? null : JSON.stringify(detail),
    }
    if (options.heartbeatAt !== undefined) patch.heartbeat_at = options.heartbeatAt
    await db.from('control').where('name', name).update(patch)
  }

  /** True when the row has no heartbeat or its heartbeat is older than maxAgeMs. */
  public static isRowStale(row: ControlRecord | null, now: number, maxAgeMs: number): boolean {
    if (!row || row.heartbeatAt === null || row.heartbeatAt === undefined) return true
    return now - row.heartbeatAt > maxAgeMs
  }

  /** True when the row has no heartbeat or its heartbeat is older than maxAgeMs. */
  public static async isStale(name: string, now = Date.now(), maxAgeMs = 2 * 60 * 60 * 1000): Promise<boolean> {
    return ControlRecord.isRowStale(await ControlRecord.get(name), now, maxAgeMs)
  }
}
