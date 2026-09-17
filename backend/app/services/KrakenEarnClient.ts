import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import KrakenService from '#services/KrakenService'

// Kraken Earn client (KTD1/KTD2): the only private Earn surface the yield
// line uses. It signs through the public KrakenService seam with its own
// dedicated credentials, never lets key material into logs or errors, and
// refuses to sign when those credentials are missing or shared with spot.

export type KrakenEarnErrorCode = 'credentials' | 'permission' | 'tier' | 'transport' | 'venue'

export class KrakenEarnError extends Error {
  constructor(
    public code: KrakenEarnErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'KrakenEarnError'
  }
}

export interface EarnCredentials {
  key: string
  secret: string
}

export interface SignedRequestSeam {
  signedRequest(
    path: string,
    params?: Record<string, any>,
    credentials?: EarnCredentials
  ): Promise<any>
}

export interface EarnStrategy {
  strategyId: string
  asset: string
  lockType: string // venue enum: instant | bonded | timed | flex
  canAllocate: boolean
  autoCompound: string | null
  minAllocationUsd: number | null
  userCapUsd: number | null
  apyLow: number | null
  apyHigh: number | null
  unbondingSeconds: number | null
}

export interface EarnAllocation {
  strategyId: string
  asset: string
  lockType: string
  canAllocate: boolean
  autoCompound: string | null
  allocatedNative: number
  pendingNative: number
  unbondingNative: number
  exitQueueNative: number
  totalRewardedNative: number
  minAllocationUsd: number | null
  userCapUsd: number | null
  apyLow: number | null
  apyHigh: number | null
  unbondingSeconds: number | null
}

export interface EarnLedgerEntry {
  refid: string
  time: number // epoch ms
  ledgerType: string // staking | reward | earn | anything the venue sends
  subtype: string | null
  asset: string
  amount: number
  balanceAfter: number | null
}

export interface EarnLedgerQuery {
  type?: string
  start?: number
  end?: number
  ofs?: number
}

export interface EarnOperationStatus {
  refid: string | null
  status: string
  strategyId: string | null
  amount: number | null
  error: string | null
}

export interface KrakenEarnClientOptions {
  key?: string
  secret?: string
  service?: SignedRequestSeam
  retryBackoffMs?: number
  delay?: (ms: number) => Promise<unknown>
  logger?: { warn(message: string): void }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1'
}

/** The venue returns either a keyed map or an array depending on endpoint/doc revision. */
function bagEntries(result: any, keys: string[]): any[] {
  for (const key of keys) {
    const bag = result?.[key]
    if (Array.isArray(bag)) return bag
    if (bag && typeof bag === 'object') {
      return Object.entries(bag).map(([id, value]) => ({ id, ...(value as any) }))
    }
  }
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object') {
    return Object.entries(result).map(([id, value]) => ({ id, ...(value as any) }))
  }
  return []
}

function parseStrategy(raw: any): EarnStrategy | null {
  const strategyId = str(raw.strategy_id ?? raw.strategyId ?? raw.id)
  if (!strategyId) return null
  return {
    strategyId,
    asset: str(raw.asset) ?? '',
    lockType: str(raw.lock_type ?? raw.lockType) ?? 'instant',
    canAllocate: bool(raw.can_allocate ?? raw.canAllocate),
    autoCompound: str(raw.auto_compound ?? raw.autoCompound),
    minAllocationUsd: num(raw.user_min_allocation ?? raw.min_allocation ?? raw.userMinAllocation),
    userCapUsd: num(raw.user_cap ?? raw.userCap),
    apyLow: num(raw.apr_estimate?.low ?? raw.apy_low ?? raw.apyLow ?? raw.apy_estimate?.low ?? raw.apy?.low),
    apyHigh: num(
      raw.apr_estimate?.high ?? raw.apy_high ?? raw.apyHigh ?? raw.apy_estimate?.high ?? raw.apy?.high
    ),
    unbondingSeconds: num(raw.unbonding_seconds ?? raw.unbondingSeconds ?? raw.lock_duration_seconds),
  }
}

function parseAllocation(raw: any): EarnAllocation | null {
  const strategyId = str(raw.strategy_id ?? raw.strategyId ?? raw.id)
  if (!strategyId) return null
  return {
    strategyId,
    asset: str(raw.asset) ?? '',
    lockType: str(raw.lock_type ?? raw.lockType) ?? 'instant',
    canAllocate: bool(raw.can_allocate ?? raw.canAllocate),
    autoCompound: str(raw.auto_compound ?? raw.autoCompound),
    allocatedNative: num(raw.allocated ?? raw.allocated_native ?? raw.balance) ?? 0,
    pendingNative: num(raw.pending ?? raw.pending_native) ?? 0,
    unbondingNative: num(raw.unbonding ?? raw.unbonding_native) ?? 0,
    exitQueueNative: num(raw.exit_queue ?? raw.exit_queue_native) ?? 0,
    totalRewardedNative: num(raw.total_rewarded ?? raw.total_rewarded_native ?? raw.total_rewarded_amount) ?? 0,
    minAllocationUsd: num(raw.user_min_allocation ?? raw.min_allocation ?? raw.userMinAllocation),
    userCapUsd: num(raw.user_cap ?? raw.userCap),
    apyLow: num(raw.apr_estimate?.low ?? raw.apy_low ?? raw.apyLow ?? raw.apy_estimate?.low ?? raw.apy?.low),
    apyHigh: num(
      raw.apr_estimate?.high ?? raw.apy_high ?? raw.apyHigh ?? raw.apy_estimate?.high ?? raw.apy?.high
    ),
    unbondingSeconds: num(raw.unbonding_seconds ?? raw.unbondingSeconds ?? raw.lock_duration_seconds),
  }
}

function parseLedgerEntry(refid: string, raw: any): EarnLedgerEntry | null {
  const asset = str(raw.asset)
  const amount = num(raw.amount)
  if (!asset || amount === null) return null
  const time = num(raw.time) ?? 0
  return {
    refid: str(raw.refid) ?? refid,
    time: time < 1e12 ? time * 1000 : time,
    ledgerType: str(raw.type) ?? 'unknown',
    subtype: str(raw.subtype),
    asset,
    amount,
    balanceAfter: num(raw.balance ?? raw.balance_after),
  }
}

function parseOperationStatus(raw: any): EarnOperationStatus {
  return {
    refid: str(raw?.refid ?? raw?.id),
    status: str(raw?.status ?? raw?.state) ?? 'unknown',
    strategyId: str(raw?.strategy_id ?? raw?.strategyId),
    amount: num(raw?.amount),
    error: str(raw?.error),
  }
}

export class KrakenEarnClient {
  private explicitKey?: string
  private explicitSecret?: string
  private service: SignedRequestSeam
  private retryBackoffMs: number
  private delay: (ms: number) => Promise<unknown>
  private logger: { warn(message: string): void }

  constructor(opts: KrakenEarnClientOptions = {}) {
    this.explicitKey = opts.key
    this.explicitSecret = opts.secret
    this.service = opts.service ?? (KrakenService as SignedRequestSeam)
    this.retryBackoffMs = opts.retryBackoffMs ?? 500
    this.delay = opts.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.logger = opts.logger ?? logger
  }

  /**
   * Resolve the dedicated Earn credentials. Null when unset/empty or when
   * they are identical to the spot credentials — the yield line must never
   * sign with the trading key.
   */
  public resolveCredentials(): EarnCredentials | null {
    const key = this.explicitKey ?? env.get('KRAKEN_EARN_KEY', '')
    const secret = this.explicitSecret ?? env.get('KRAKEN_EARN_SECRET', '')
    if (!key || !secret) return null
    const spotKey = env.get('KRAKEN_API_KEY', '')
    const spotSecret = env.get('KRAKEN_API_SECRET', '')
    if ((spotKey && key === spotKey) || (spotSecret && secret === spotSecret)) return null
    return { key, secret }
  }

  // ---------------------------------------------------------------------------
  // Earn endpoints (KTD1 — /0/private/Earn/*; never the retired Staking paths)
  // ---------------------------------------------------------------------------

  public async getStrategies(): Promise<EarnStrategy[]> {
    const result = await this.signed('/0/private/Earn/Strategies')
    return bagEntries(result, ['items', 'strategies'])
      .map(parseStrategy)
      .filter((row): row is EarnStrategy => row !== null)
  }

  public async getAllocations(): Promise<EarnAllocation[]> {
    const result = await this.signed('/0/private/Earn/Allocations')
    return bagEntries(result, ['items', 'allocations'])
      .map(parseAllocation)
      .filter((row): row is EarnAllocation => row !== null)
  }

  public async allocate(strategyId: string, amount: number): Promise<{ refid: string | null }> {
    const result = await this.signed('/0/private/Earn/Allocate', {
      strategy_id: strategyId,
      amount: String(amount),
    })
    return { refid: str(result?.refid ?? result?.id) }
  }

  public async deallocate(strategyId: string, amount: number): Promise<{ refid: string | null }> {
    const result = await this.signed('/0/private/Earn/Deallocate', {
      strategy_id: strategyId,
      amount: String(amount),
    })
    return { refid: str(result?.refid ?? result?.id) }
  }

  public async getAllocateStatus(refid: string): Promise<EarnOperationStatus> {
    const result = await this.signed('/0/private/Earn/AllocateStatus', { refid })
    return parseOperationStatus(result)
  }

  public async getDeallocateStatus(refid: string): Promise<EarnOperationStatus> {
    const result = await this.signed('/0/private/Earn/DeallocateStatus', { refid })
    return parseOperationStatus(result)
  }

  public async getLedgers(query: EarnLedgerQuery = {}): Promise<{ entries: EarnLedgerEntry[]; count: number }> {
    const params: Record<string, any> = {}
    if (query.type) params.type = query.type
    if (query.start !== undefined) params.start = query.start
    if (query.end !== undefined) params.end = query.end
    if (query.ofs !== undefined) params.ofs = query.ofs

    const result = await this.signed('/0/private/Ledgers', params)
    const ledger = result?.ledger ?? {}
    const entries = Object.entries(ledger)
      .map(([refid, row]) => parseLedgerEntry(refid, row))
      .filter((row): row is EarnLedgerEntry => row !== null)
    return { entries, count: num(result?.count) ?? entries.length }
  }

  // ---------------------------------------------------------------------------
  // Signing + error handling
  // ---------------------------------------------------------------------------

  private async signed(path: string, params: Record<string, any> = {}): Promise<any> {
    const credentials = this.resolveCredentials()
    if (!credentials) {
      throw new KrakenEarnError(
        'credentials',
        'earn credentials missing or identical to the spot credentials'
      )
    }
    return this.request(() => this.service.signedRequest(path, params, credentials))
  }

  private async request(call: () => Promise<any>): Promise<any> {
    try {
      return await call()
    } catch (error) {
      if (!this.isTransportError(error)) throw this.toTypedError(error)
      await this.delay(this.retryBackoffMs)
      try {
        return await call()
      } catch (second) {
        if (!this.isTransportError(second)) throw this.toTypedError(second)
        const typed = new KrakenEarnError('transport', this.redact(this.messageOf(second)))
        this.logger.warn(`[KrakenEarn] ${typed.code}: ${typed.message}`)
        throw typed
      }
    }
  }

  /** Transport failures are the only retryable class; venue errors are deterministic. */
  private isTransportError(error: unknown): boolean {
    if (error instanceof KrakenEarnError) return false
    const message = this.messageOf(error)
    const http = message.match(/Kraken HTTP (\d+)/)
    if (http) return Number(http[1]) >= 500
    if (/^E[A-Za-z]+:/.test(message)) return false
    return true
  }

  private toTypedError(error: unknown): KrakenEarnError {
    if (error instanceof KrakenEarnError) return error
    const message = this.redact(this.messageOf(error))
    const code: KrakenEarnErrorCode = /permission|invalid key|invalid api key/i.test(message)
      ? 'permission'
      : /tier|region/i.test(message)
        ? 'tier'
        : 'venue'
    const typed = new KrakenEarnError(code, message)
    this.logger.warn(`[KrakenEarn] ${typed.code}: ${typed.message}`)
    return typed
  }

  /** Strip Earn key material from anything that could reach a log or an error. */
  private redact(text: string): string {
    let out = text
    const credentials = this.resolveCredentials()
    if (credentials) {
      if (credentials.key) out = out.split(credentials.key).join('[redacted]')
      if (credentials.secret) out = out.split(credentials.secret).join('[redacted]')
    }
    return out
  }

  private messageOf(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }
}

export default new KrakenEarnClient()
