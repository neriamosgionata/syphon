import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Persisted alert row. Messages are redacted: no balances, equity, keys,
 * or signed payloads (KTD9/KTD11).
 */
export default class OperationAlert extends BaseModel {
  public static table = 'operation_alerts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare source: string // yield | trend | shared

  @column()
  declare severity: string // info | warning | critical

  @column()
  declare code: string

  @column()
  declare message: string

  @column()
  declare createdAt: number // epoch ms

  @column()
  declare acknowledgedAt: number | null

  public static async raise(input: {
    source: string
    severity: string
    code: string
    message: string
    now?: number
  }): Promise<OperationAlert> {
    return OperationAlert.create({
      source: input.source,
      severity: input.severity,
      code: input.code,
      message: input.message.slice(0, 512),
      createdAt: input.now ?? Date.now(),
      acknowledgedAt: null,
    })
  }

  public static async unacknowledged(source?: string): Promise<OperationAlert[]> {
    const query = OperationAlert.query().whereNull('acknowledged_at').orderBy('created_at', 'asc')
    if (source) query.where('source', source)
    return query
  }
}
