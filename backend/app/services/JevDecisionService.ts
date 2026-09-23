import env from '#start/env'
import logger from '@adonisjs/core/services/logger'

// ─── Jev sidecar client (U1) ─────────────────────────────────────
//
// Version-pinned, injectable scoring transport for the fast algo decision
// layer. One batched Jev call per symbol per tick; every transport failure
// class degrades to a null context so the deterministic strategy path runs
// unchanged. Nothing here trades — it only shapes facts, scores them, and
// reports provenance + token usage for spend tracking.
//
// Conventions mirrored: the signed-request seam + typed-error + single-retry
// + redaction discipline of KrakenEarnClient; the fail-open null convention
// of NewsSentimentService. The strategy itself gains only an optional
// context param in a later unit — never I/O.
//
// Vendor surface used (SDK @typesafe-ai/sdk, rechecked at integration):
// POST https://api.typesafe.ai/v1/systemone, Bearer $TYPESAFE_API_KEY,
// primitives choice/noul/score, confidence on Choice/Score. Model
// jev-1.13.0 is pinned per call — never the jev-latest alias.

export const JEV_MODEL_ID = 'jev-1.13.0'
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
/** Documented Jev pricing: $0.042 per million input tokens, output free. */
export const JEV_PRICE_PER_K_INPUT_USD = 0.000042
export const JEV_PRICE_PER_K_OUTPUT_USD = 0
/** Per-call timeout — near 2s so a Jev round trip fits inside the tick budget. */
export const JEV_TIMEOUT_MS = 2000
/** Per-call input-size cap (serialized JSON chars); overflow truncates headlines, never facts. */
export const JEV_MAX_INPUT_CHARS = 8000
/** Failed ticks reuse the last good context this long, then degrade to null. */
export const JEV_STALE_REUSE_MS = 90_000
/** Below this combined confidence the answer degrades to null. */
export const JEV_MIN_CONFIDENCE = 0.5
export const JEV_MAX_HEADLINES = 10
export const JEV_MAX_HEADLINE_CHARS = 280
/** Fresh preflight required for live enablement (R13). */
export const JEV_PREFLIGHT_TTL_MS = 3_600_000
/** Prompt version stamped per score — replay joins on model|question|prompt. */
export const JEV_PROMPT_VERSION = 'v1'

export type JevFailureClass =
  | 'timeout'
  | 'rate_limited'
  | 'transport'
  | 'validation'
  | 'auth'
  | 'shape_drift'
  | 'budget'
  | 'unkeyed'
  | 'low_confidence'
  | 'stale'

export interface JevFailure {
  class: JevFailureClass
  /** Redacted — never carries credential material, headers, or raw bodies. */
  message: string
  at: number
}

/** Price-derived indicator facts only — the explicit outbound allowlist. */
export interface JevIndicatorFacts {
  momentumPct?: number | null
  rsi?: number | null
  emaSlopePct?: number | null
  volatilityPct?: number | null
  priceChangePct?: number | null
}

export interface JevSymbolState {
  symbol: string
  facts: JevIndicatorFacts
  /** Raw headlines; shaped (stripped/deduped/capped) in code before sending. */
  headlines: string[]
  asOf?: number
}

export interface JevDecisionContext {
  symbol: string
  /** Calibrated probability of an up move over the next interval. */
  pUp: number
  /** Calibrated probability of a down move. */
  pDown: number
  /** Combined (min) Choice/Score confidence. */
  confidence: number
  /** Responding model — provenance, logged per decision. */
  model: string
  usage: { inputTokens: number; outputTokens: number }
  asOf: number
  stale: boolean
  fixture?: boolean
}

export interface JevFixture {
  pUp: number
  pDown: number
  confidence: number
}

export interface JevRequestBody {
  model: string
  state: { symbol: string; indicators: Record<string, number>; headlines: string[] }
  questions: {
    direction: { type: 'choice'; instructions: string; criteria: Record<string, null> }
    strength: { type: 'score'; instructions: string; criteria: string[] }
  }
}

export interface JevRawResult {
  model: string
  answers: Record<string, any>
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Interface seam hiding the SDK (KTD11): injected transport, SDK surface, or raw HTTPS. */
export interface JevTransport {
  score(body: JevRequestBody, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<JevRawResult>
}

/** Minimal SDK surface the service touches (scoring call only). */
export interface JevSdkLike {
  systemOne(request: any, options?: any): Promise<any>
}

/** Stable hash of the question definitions — binds recorded scores to the
 *  exact questions that produced them (promotion joins on model+hash). */
export function jevQuestionHash(): string {
  const serialized = JSON.stringify(buildQuestions())
  let hash = 0x811c9dc5
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export interface JevAlert {
  kind: 'auth' | 'shape_drift' | 'budget'
  message: string
}

export interface JevBudgetState {
  day: string
  calls: number
  spendUsd: number
  maxCallsPerDay: number
  maxSpendUsdPerDay: number
  deterministicOnly: boolean
}

export interface JevPreflight {
  ok: boolean
  model: string | null
  failure: JevFailure | null
  at: number
}

export interface JevDecisionServiceOptions {
  apiKey?: string
  modelId?: string
  /** Injectable seam for tests — when set, no SDK/fetch path is used. */
  transport?: JevTransport | null
  /** Injectable SDK surface; null forces the raw-HTTPS fallback; undefined auto-resolves. */
  sdk?: JevSdkLike | null
  /** Injectable fetch seam for the raw-HTTPS fallback. */
  fetch?: typeof fetch
  timeoutMs?: number
  maxInputChars?: number
  minConfidence?: number
  maxCallsPerDay?: number
  maxSpendUsdPerDay?: number
  pricePerKInputUsd?: number
  pricePerKOutputUsd?: number
  staleReuseMs?: number
  now?: () => number
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void }
  onAlert?: (alert: JevAlert) => void
  /** Recorded fixtures served when unkeyed (tests / offline dev). */
  fixtures?: Record<string, JevFixture>
}

type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void }

/** Indicator fields allowed on the wire — everything else is dropped. */
const INDICATOR_ALLOWLIST: (keyof JevIndicatorFacts)[] = [
  'momentumPct',
  'rsi',
  'emaSlopePct',
  'volatilityPct',
  'priceChangePct',
]

/** The two atomic questions for a symbol, composed in code (R4). Plain,
 *  non-numeric wording: no derivations, counting, dates, or negation. */
function buildQuestions(): JevRequestBody['questions'] {
  return {
    direction: {
      type: 'choice',
      instructions: 'Which direction does the evidence favor for the move ahead?',
      criteria: { up: null, down: null, flat: null },
    },
    strength: {
      type: 'score',
      instructions: 'How strong is the evidence for the favored direction?',
      criteria: ['no evidence', 'weak evidence', 'firm evidence', 'strong evidence'],
    },
  }
}

/** FNV-1a hex of a string — non-reversible fingerprint for key-rotation
 *  detection. Never the key or a prefix; safe to hold beside the latch. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function stripHeadline(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const out = raw
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return out.length > 0 ? out : null
}

/** Shape headlines: strip URLs/markup, drop empties, dedupe, cap count × length. */
export function shapeHeadlines(headlines: string[]): string[] {
  const seen = new Set<string>()
  const shaped: string[] = []
  for (const raw of headlines ?? []) {
    const clean = stripHeadline(raw)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    shaped.push(clean.slice(0, JEV_MAX_HEADLINE_CHARS))
    if (shaped.length >= JEV_MAX_HEADLINES) break
  }
  return shaped
}

function pickIndicators(facts: JevIndicatorFacts): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of INDICATOR_ALLOWLIST) {
    const value = facts?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

class JevError extends Error {
  constructor(
    public failureClass: Exclude<JevFailureClass, 'budget' | 'unkeyed' | 'low_confidence' | 'stale'>,
    message: string,
    public retryable: boolean = false,
    public retryAfterMs?: number
  ) {
    super(message)
    this.name = 'JevError'
  }
}

function headerValue(headers: any, name: string): string | null {
  if (!headers) return null
  try {
    if (typeof headers.get === 'function') {
      const value = headers.get(name)
      return value === undefined || value === null ? null : String(value)
    }
    const lower = name.toLowerCase()
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        const value = headers[key]
        return value === undefined || value === null ? null : String(value)
      }
    }
  } catch {
    return null
  }
  return null
}

function parseRetryAfterMs(error: any): number {
  const direct = Number((error as any)?.retryAfterMs)
  if (Number.isFinite(direct) && direct > 0) {
    return Math.min(Math.max(Math.round(direct), 1000), 300_000)
  }
  const headers = (error as any)?.headers
  const raw = headerValue(headers, 'retry-after') ?? headerValue(headers, 'retry-after-ms')
  if (raw !== null) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds > 0) {
      const asMs = raw.trim().toLowerCase().endsWith('ms') ? seconds : seconds * 1000
      return Math.min(Math.max(Math.round(asMs), 1000), 300_000)
    }
    const dateMs = Date.parse(raw)
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 1000), 300_000)
    }
  }
  return 60_000
}

/** Classify a transport/SDK failure: class + whether one retry is allowed.
 *  Retryable: timeout, connection loss, 5xx (except 529-overload). Never
 *  retried: auth (alert), rate-limit incl. 529 (backoff latch, no tick wait),
 *  validation/4xx (deterministic), shape drift (fallback instead). */
function classify(error: unknown): { failureClass: JevError['failureClass']; retryable: boolean; retryAfterMs?: number } {
  const anyErr = error as any
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined
  if (status === 401 || status === 403) return { failureClass: 'auth', retryable: false }
  if (status === 429 || status === 529) {
    return { failureClass: 'rate_limited', retryable: false, retryAfterMs: parseRetryAfterMs(error) }
  }
  if (status === 422) return { failureClass: 'validation', retryable: false }
  if (status !== undefined && status >= 400 && status < 500) return { failureClass: 'validation', retryable: false }
  if (status !== undefined && status >= 500) return { failureClass: 'transport', retryable: true }
  const name = String(anyErr?.name ?? '')
  const code = String(anyErr?.code ?? '')
  const message = error instanceof Error ? error.message : String(error)
  if (/APITimeoutError|TimeoutError|AbortError/i.test(name) || /ETIMEDOUT|timed?\s?out/i.test(`${code} ${message}`)) {
    return { failureClass: 'timeout', retryable: true }
  }
  return { failureClass: 'transport', retryable: true }
}

function toJevError(error: unknown): JevError {
  if (error instanceof JevError) return error
  const { failureClass, retryable, retryAfterMs } = classify(error)
  const raw = error instanceof Error ? error.message : String(error)
  return new JevError(failureClass, raw, retryable, retryAfterMs)
}

export class JevDecisionService {
  private opts: JevDecisionServiceOptions
  private log: Logger
  private sdkCache: JevSdkLike | null | undefined
  private cache = new Map<string, { ctx: JevDecisionContext; at: number }>()
  private lastFailure: JevFailure | null = null
  private provenance: { model: string; usage: { inputTokens: number; outputTokens: number }; at: number; symbol: string } | null = null
  private budget = { day: '', calls: 0, spendUsd: 0 }
  private latch: { kind: 'auth' | 'budget'; day: string; keyFingerprint?: string } | null = null
  private budgetAlertedDay = ''
  private rateLimitedUntil = 0
  private preflightAt = 0
  private preflightOk = false

  constructor(opts: JevDecisionServiceOptions = {}) {
    // Offline-safe: no env reads, no network, no SDK import at construction.
    this.opts = opts
    this.log = opts.logger ?? logger
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private timeoutMs(): number {
    return this.opts.timeoutMs ?? JEV_TIMEOUT_MS
  }

  /** Credential from explicit option or environment — rotates without code change (R13). */
  public resolveApiKey(): string | null {    if (this.opts.apiKey !== undefined) return this.opts.apiKey || null
    try {
      return env.get('TYPESAFE_API_KEY', '') || null
    } catch {
      return null
    }
  }

  /** Stable hash of this service's question definitions (promotion joins on it). */
  public getQuestionHash(): string {
    return jevQuestionHash()
  }

  private modelId(): string {
    return this.opts.modelId ?? JEV_MODEL_ID
  }

  // ------------------------------------------------------------------
  // Request shaping (allowlisted payload — R4, security binding)
  // ------------------------------------------------------------------

  public buildRequestBody(state: JevSymbolState): JevRequestBody {
    const body: JevRequestBody = {
      model: this.modelId(),
      state: {
        symbol: state.symbol,
        indicators: pickIndicators(state.facts),
        headlines: shapeHeadlines(state.headlines),
      },
      questions: buildQuestions(),
    }
    const cap = this.opts.maxInputChars ?? JEV_MAX_INPUT_CHARS
    let serialized = JSON.stringify(body)
    // Truncate headlines only — indicator facts are never dropped.
    while (serialized.length > cap && body.state.headlines.length > 0) {
      const longest = body.state.headlines.reduce((a, b) => (a.length >= b.length ? a : b))
      if (longest.length > 48) {
        body.state.headlines = body.state.headlines.map((h) =>
          h === longest ? h.slice(0, Math.max(24, Math.floor(h.length / 2))).trimEnd() : h
        )
      } else {
        body.state.headlines = body.state.headlines.slice(0, -1)
      }
      serialized = JSON.stringify(body)
    }
    return body
  }

  // ------------------------------------------------------------------
  // Main entry: one batched call per symbol per tick, fail-open null
  // ------------------------------------------------------------------

  public async getDecision(state: JevSymbolState): Promise<JevDecisionContext | null> {
    const now = this.now()
    const key = this.resolveApiKey()

    if (!key) {
      const fixture = this.opts.fixtures?.[state.symbol]
      if (fixture) return this.fixtureContext(state, fixture, now)
      return this.record({ class: 'unkeyed', message: 'jev credentials unset and no fixture recorded', at: now }, state, null)
    }

    this.rollDay(now)
    if (this.latch?.kind === 'auth') {
      // Same-day key rotation clears the auth latch: the new credential has
      // never failed, so the call that proves recovery must proceed. The
      // latch holds only a non-reversible fingerprint — never key material.
      if (fnv1aHex(key) !== this.latch.keyFingerprint) {
        this.latch = null
      }
    }
    if (this.latch) {
      const failureClass: JevFailureClass = this.latch.kind === 'auth' ? 'auth' : 'budget'
      return this.record(
        { class: failureClass, message: `deterministic-only (${this.latch.kind} latched)`, at: now },
        state,
        null
      )
    }
    if (now < this.rateLimitedUntil) {
      return this.record(
        { class: 'rate_limited', message: 'rate limited, backing off without tick-blocking wait', at: now },
        state,
        null
      )
    }
    // Budget gate before the call: the Nth call within budget proceeds and
    // latches on completion; call N+1 degrades without touching the network.
    if (this.overBudget()) {
      this.latch = { kind: 'budget', day: this.budget.day }
      return this.record({ class: 'budget', message: 'daily budget breached, deterministic-only', at: now }, state, null)
    }

    const body = this.buildRequestBody(state)
    const primary = await this.primaryTransport(key)
    let raw: JevRawResult | null = null
    let failure: JevFailure | null = null

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.withTimeout(
          (signal) => primary.score(body, { signal, timeoutMs: this.timeoutMs() }),
          this.timeoutMs()
        )
        raw = result
        failure = null
        break
      } catch (error) {
        const typed = this.redactedError(error)
        if (typed.failureClass === 'shape_drift' && primary.kind === 'sdk') {
          // SDK shape drift falls over to the raw-HTTPS fallback with alert.
          this.alert({ kind: 'shape_drift', message: typed.message })
          try {
            raw = await this.withTimeout(
              (signal) => this.rawTransport(key).score(body, { signal, timeoutMs: this.timeoutMs() }),
              this.timeoutMs()
            )
            failure = null
            break
          } catch (fallbackError) {
            failure = this.toFailure(this.redactedError(fallbackError), now)
            break
          }
        }
        if (typed.retryable && attempt === 0) continue
        failure = this.toFailure(typed, now)
        break
      }
    }

    if (raw && !failure) {
      const parsed = this.parseResult(state, raw, now)
      if (parsed.ok) {
        // A latch set by EARLIER calls blocks this one; this call's own
        // usage latches only subsequent calls — the Nth call proceeds.
        if (this.latch?.kind === 'budget') {
          return this.record({ class: 'budget', message: 'daily budget breached, deterministic-only', at: now }, state, null)
        }
        this.countCall(parsed.usage)
        this.cache.set(state.symbol, { ctx: parsed.ctx, at: now })
        this.provenance = { model: parsed.ctx.model, usage: parsed.ctx.usage, at: now, symbol: state.symbol }
        this.safeLog('info', `[Jev] ${state.symbol} model=${parsed.ctx.model} pUp=${parsed.ctx.pUp.toFixed(3)} conf=${parsed.ctx.confidence.toFixed(2)} in=${parsed.ctx.usage.inputTokens} out=${parsed.ctx.usage.outputTokens}`)
        this.lastFailure = null
        return parsed.ctx
      }
      failure = parsed.failure
    }

    return this.onFailure(state, failure ?? this.toFailure(new JevError('transport', 'unknown jev failure', false), now), now)
  }

  private onFailure(state: JevSymbolState, failure: JevFailure, now: number): null | JevDecisionContext {
    if (failure.class === 'auth') {
      const latchedKey = this.resolveApiKey()
      this.latch = {
        kind: 'auth',
        day: this.budget.day,
        keyFingerprint: latchedKey ? fnv1aHex(latchedKey) : undefined,
      }
      this.alert({ kind: 'auth', message: failure.message })
    }
    if (failure.class === 'rate_limited') {
      const waitMs = (failure as any).retryAfterMs ?? 60_000
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, now + waitMs)
    }
    // Stale reuse covers infra failures only — deterministic rejections
    // (validation/auth/shape/low-confidence/budget) degrade straight to null.
    if (failure.class === 'transport' || failure.class === 'timeout' || failure.class === 'rate_limited') {
      const cached = this.cache.get(state.symbol)
      const windowMs = this.opts.staleReuseMs ?? JEV_STALE_REUSE_MS
      if (cached && now - cached.at <= windowMs) {
        this.lastFailure = failure
        this.safeLog('info', `[Jev] ${state.symbol} ${failure.class}: serving stale context (${Math.round((now - cached.at) / 1000)}s old)`)
        return { ...cached.ctx, stale: true }
      }
      if (cached) {
        return this.record({ class: 'stale', message: `cached context older than ${Math.round(windowMs / 1000)}s`, at: now }, state, null)
      }
    }
    this.countCall(null)
    return this.record(failure, state, null)
  }

  private record(failure: JevFailure, state: JevSymbolState, _ctx: null): null {
    this.lastFailure = failure
    this.safeLog('warn', `[Jev] ${state.symbol} ${failure.class}: ${failure.message}`)
    return null
  }

  // ------------------------------------------------------------------
  // Response parsing + validation (never silently follow a moved alias)
  // ------------------------------------------------------------------

  /** Semantic validation shared by the SDK wrapper (throws → raw fallback)
   *  and the result parser (throws → shape_drift failure). A response whose
   *  probabilities or confidences are not finite 0..1 numbers is drift. */
  private validateAnswerSemantics(raw: JevRawResult): { pUp: number; pDown: number; dirConf: number; strConf: number } {
    const direction = raw.answers?.direction
    const strength = raw.answers?.strength
    const probs = direction?.probabilities
    const pUp = Number(probs?.up)
    const pDown = Number(probs?.down)
    const dirConf = Number(direction?.confidence)
    const strConf = Number(strength?.confidence)
    if (![pUp, pDown, dirConf, strConf].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
      throw new JevError('shape_drift', 'jev response has non-numeric probabilities or confidence', false)
    }
    return { pUp, pDown, dirConf, strConf }
  }

  private parseResult(
    state: JevSymbolState,
    raw: JevRawResult,
    now: number
  ): { ok: true; ctx: JevDecisionContext; usage: { inputTokens: number; outputTokens: number } } | { ok: false; failure: JevFailure } {
    const fail = (message: string): { ok: false; failure: JevFailure } => {
      const failure: JevFailure = { class: 'shape_drift', message, at: now }
      this.alert({ kind: 'shape_drift', message })
      return { ok: false, failure }
    }
    if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string') {
      return fail('jev response missing model provenance')
    }
    if (raw.model !== this.modelId()) {
      return fail(`jev responding model ${raw.model} differs from pinned ${this.modelId()}`)
    }
    let semantics: { pUp: number; pDown: number; dirConf: number; strConf: number }
    try {
      semantics = this.validateAnswerSemantics(raw)
    } catch {
      return fail('jev response has non-numeric probabilities or confidence')
    }
    const { pUp, pDown, dirConf, strConf } = semantics
    const inTokens = Math.max(0, Math.floor(Number(raw.usage?.input_tokens) || 0))
    const outTokens = Math.max(0, Math.floor(Number(raw.usage?.output_tokens) || 0))
    const usage = { inputTokens: inTokens, outputTokens: outTokens }
    const confidence = Math.min(dirConf, strConf)
    const minConf = this.opts.minConfidence ?? JEV_MIN_CONFIDENCE
    if (confidence < minConf) {
      return { ok: false, failure: { class: 'low_confidence', message: `jev confidence ${confidence.toFixed(2)} < ${minConf}`, at: now } }
    }
    return {
      ok: true,
      usage,
      ctx: {
        symbol: state.symbol,
        pUp,
        pDown,
        confidence,
        model: raw.model,
        usage,
        asOf: state.asOf ?? now,
        stale: false,
      },
    }
  }

  // ------------------------------------------------------------------
  // Transports: injected seam → SDK → raw HTTPS fallback
  // ------------------------------------------------------------------

  private fetchImpl(): typeof fetch {
    return this.opts.fetch ?? fetch
  }

  private async primaryTransport(key: string): Promise<{ kind: 'injected' | 'sdk' | 'raw'; score: JevTransport['score'] }> {
    if (this.opts.transport) return { kind: 'injected', score: (body, opts) => this.opts.transport!.score(body, opts) }
    const sdk = await this.loadSdk(key)
    if (sdk) {
      return {
        kind: 'sdk',
        score: async (body, opts) => {
          try {
            const result = await sdk.systemOne(
              { model: body.model, state: body.state, questions: body.questions },
              { signal: opts?.signal, timeout: opts?.timeoutMs ?? this.timeoutMs() }
            )
            const normalized = this.normalizeSdkResult(result)
            // Semantic drift throws here so getDecision fails over to raw HTTPS.
            this.validateAnswerSemantics(normalized)
            return normalized
          } catch (error) {
            throw this.redactedError(error)
          }
        },
      }
    }
    return { kind: 'raw', score: (body, opts) => this.rawTransport(key).score(body, opts) }
  }

  private rawTransport(key: string): JevTransport {
    const impl = this.fetchImpl()
    return {
      score: async (body, opts) => {
        let res: Response
        try {
          res = await impl(JEV_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: opts?.signal,
          })
        } catch (error) {
          throw this.redactedError(error)
        }
        if (!res.ok) {
          throw this.redactedError({ status: res.status, headers: (res as any).headers, message: `Jev HTTP ${res.status}` })
        }
        let parsed: any
        try {
          parsed = await res.json()
        } catch (error) {
          throw this.redactedError({ status: res.status, message: `Jev HTTP ${res.status} (unparseable body)` })
        }
        return this.normalizeSdkResult(parsed)
      },
    }
  }

  /** Normalize SDK/raw payloads; malformed shapes throw shape_drift (no retry — fallback instead). */
  private normalizeSdkResult(result: any): JevRawResult {
    const answers = result?.answers
    if (!result || typeof result !== 'object' || typeof result.model !== 'string' || !answers || typeof answers !== 'object') {
      throw new JevError('shape_drift', 'jev response failed shape validation', false)
    }
    return { model: result.model, answers, usage: result.usage }
  }

  private async loadSdk(key: string): Promise<JevSdkLike | null> {
    if (this.opts.sdk !== undefined) return this.opts.sdk
    if (this.sdkCache !== undefined) return this.sdkCache
    try {
      const mod: any = await import('@typesafe-ai/sdk')
      this.sdkCache = new mod.TypeSafeClient({
        apiKey: key,
        timeout: this.timeoutMs(),
        retry: { maxRetries: 0 },
        logLevel: 'off',
        fetch: this.fetchImpl(),
      })
    } catch {
      this.sdkCache = null
    }
    return this.sdkCache
  }

  private withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    const controller = new AbortController()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(new JevError('timeout', `jev call timed out after ${ms}ms`, true))
      }, ms)
      work(controller.signal).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  // ------------------------------------------------------------------
  // Budgets, preflight, introspection
  // ------------------------------------------------------------------

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10)
    if (this.budget.day !== day) {
      this.budget = { day, calls: 0, spendUsd: 0 }
      this.latch = null
      this.budgetAlertedDay = ''
    }
  }

  private spendFor(usage: { inputTokens: number; outputTokens: number }): number {
    // Documented Jev pricing: $0.042/MTok input, output free (too cheap to meter).
    const inRate = this.opts.pricePerKInputUsd ?? JEV_PRICE_PER_K_INPUT_USD
    const outRate = this.opts.pricePerKOutputUsd ?? JEV_PRICE_PER_K_OUTPUT_USD
    return (usage.inputTokens / 1000) * inRate + (usage.outputTokens / 1000) * outRate
  }

  private overBudget(): boolean {
    const maxCalls = this.opts.maxCallsPerDay ?? 10_000
    const maxSpend = this.opts.maxSpendUsdPerDay ?? 50
    return this.budget.calls >= maxCalls || this.budget.spendUsd >= maxSpend
  }

  private countCall(usage: { inputTokens: number; outputTokens: number } | null): void {
    this.budget.calls++
    if (usage) this.budget.spendUsd += this.spendFor(usage)
    const maxCalls = this.opts.maxCallsPerDay ?? 10_000
    const maxSpend = this.opts.maxSpendUsdPerDay ?? 50
    if (this.budget.calls >= maxCalls || this.budget.spendUsd >= maxSpend) {
      this.latch = { kind: 'budget', day: this.budget.day }
      if (this.budgetAlertedDay !== this.budget.day) {
        this.budgetAlertedDay = this.budget.day
        this.alert({ kind: 'budget', message: `jev daily budget breached (${this.budget.calls} calls, $${this.budget.spendUsd.toFixed(4)}), deterministic-only` })
      }
    }
  }

  public getBudgetState(): JevBudgetState {
    this.rollDay(this.now())
    return {
      day: this.budget.day,
      calls: this.budget.calls,
      spendUsd: this.budget.spendUsd,
      maxCallsPerDay: this.opts.maxCallsPerDay ?? 10_000,
      maxSpendUsdPerDay: this.opts.maxSpendUsdPerDay ?? 50,
      deterministicOnly: this.latch !== null,
    }
  }

  public isDeterministicOnly(): boolean {
    this.rollDay(this.now())
    return this.latch !== null
  }

  public getLastFailure(): JevFailure | null {
    return this.lastFailure
  }

  public getProvenance(): { model: string; usage: { inputTokens: number; outputTokens: number }; at: number; symbol: string } | null {
    return this.provenance
  }

  /** Fresh preflight for live enablement (R13): minimal scoring call
   *  proving key + pinned model + response shape. */
  public async preflight(): Promise<JevPreflight> {
    const now = this.now()
    const key = this.resolveApiKey()
    if (!key) {
      return { ok: false, model: null, failure: { class: 'unkeyed', message: 'jev credentials unset', at: now }, at: now }
    }
    this.rollDay(now)
    const body = this.buildRequestBody({ symbol: 'PREFLIGHT', facts: {}, headlines: [] })
    const primary = await this.primaryTransport(key)
    try {
      const raw = await this.withTimeout(
        (signal) => primary.score(body, { signal, timeoutMs: this.timeoutMs() }),
        this.timeoutMs()
      )
      const parsed = this.parseResult({ symbol: 'PREFLIGHT', facts: {}, headlines: [] }, raw, now)
      if (!parsed.ok) {
        return { ok: false, model: raw?.model ?? null, failure: parsed.failure, at: now }
      }
      this.countCall(parsed.usage)
      this.preflightAt = now
      this.preflightOk = true
      // A passing preflight proves the credential — lift an auth latch.
      if (this.latch?.kind === 'auth') this.latch = null
      this.safeLog('info', `[Jev] preflight ok model=${parsed.ctx.model}`)
      return { ok: true, model: parsed.ctx.model, failure: null, at: now }
    } catch (error) {
      const typed = this.redactedError(error)
      return { ok: false, model: null, failure: this.toFailure(typed, now), at: now }
    }
  }

  public isLiveReady(maxAgeMs: number = JEV_PREFLIGHT_TTL_MS): boolean {
    if (!this.preflightOk || this.preflightAt <= 0) return false
    return this.now() - this.preflightAt <= maxAgeMs
  }

  // ------------------------------------------------------------------
  // Redaction, logging, alerts (all fail-open — never throw into a tick)
  // ------------------------------------------------------------------

  private fixtureContext(state: JevSymbolState, fixture: JevFixture, now: number): JevDecisionContext {
    const ctx: JevDecisionContext = {
      symbol: state.symbol,
      pUp: fixture.pUp,
      pDown: fixture.pDown,
      confidence: fixture.confidence,
      model: `${this.modelId()}:fixture`,
      usage: { inputTokens: 0, outputTokens: 0 },
      asOf: state.asOf ?? now,
      stale: false,
      fixture: true,
    }
    this.safeLog('info', `[Jev] ${state.symbol} fixture model=${ctx.model} pUp=${ctx.pUp}`)
    return ctx
  }

  /** Strip credential material from anything that could reach state or logs. */
  private redact(text: string): string {
    let out = text
    const key = this.resolveApiKey()
    if (key) out = out.split(key).join('[redacted]')
    return out
  }

  private redactedError(error: unknown): JevError {
    const typed = toJevError(error)
    const clean = this.redact(typed.message)
    const out = new JevError(typed.failureClass, clean, typed.retryable, typed.retryAfterMs)
    // Preserve rate-limit metadata without preserving headers.
    if (typed.failureClass === 'rate_limited') (out as any).retryAfterMs = typed.retryAfterMs
    return out
  }

  private toFailure(error: JevError, now: number): JevFailure {
    const failure = { class: error.failureClass as JevFailureClass, message: error.message, at: now } as any
    if (error.retryAfterMs !== undefined) failure.retryAfterMs = error.retryAfterMs
    return failure
  }

  private safeLog(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      this.log[level](this.redact(message))
    } catch {
      // Logging must never throw into a tick.
    }
  }

  private alert(alert: JevAlert): void {
    try {
      if (this.opts.onAlert) {
        this.opts.onAlert({ kind: alert.kind, message: this.redact(alert.message) })
      } else {
        this.safeLog('warn', `[Jev][alert:${alert.kind}] ${alert.message}`)
      }
    } catch {
      // Alert handlers must never throw into a tick.
    }
  }
}

export default new JevDecisionService()
