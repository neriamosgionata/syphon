import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Append-only record of one mutating Earn operation. Created before the
 * venue request (intent-first); identity fields never change, only the
 * terminal status and its timestamps.
 */
export default class OperationIntent extends BaseModel {
  public static table = 'operation_intents'

  public static TERMINAL_STATUSES = ['success', 'failed'] as const

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare strategyId: string

  @column()
  declare asset: string

  @column()
  declare type: string // allocate | deallocate

  @column()
  declare status: string // pending | submitted | success | failed

  @column()
  declare amountNative: number | null

  @column()
  declare amountUsd: number | null

  @column()
  declare priceUsd: number | null

  @column()
  declare refid: string | null

  @column()
  declare error: string | null

  @column()
  declare createdAt: number

  @column()
  declare submittedAt: number | null

  @column()
  declare terminalAt: number | null

  public get terminal(): boolean {
    return (OperationIntent.TERMINAL_STATUSES as readonly string[]).includes(this.status)
  }
}
