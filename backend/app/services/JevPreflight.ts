import fs from 'node:fs'
import env from '#start/env'
import OperationAlert from '#models/OperationAlert'
import ControlRecord from '#models/ControlRecord'
import { JEV_MODEL_ID } from '#services/JevDecisionService'
import { isPreflightFresh } from '#services/YieldPreflight'

// ─── Jev preflight (U6) ─────────────────────────────────────────
//
// Live enablement needs a fresh recorded pass: the credential exists, the
// scorer answers with the pinned model, and no jev alert waits for review.
// Mirrors the yield preflight shape (local / venue / environment layers,
// recorded pass with TTL) without touching order paths.

export const JEV_PREFLIGHT_CONTROL_NAME = 'jev:preflight'
export const JEV_PREFLIGHT_TTL_MS = 60 * 60 * 1000

export interface JevPreflightCheck {
  layer: 'local' | 'venue' | 'environment'
  name: string
  ok: boolean
  detail?: string
}

export interface JevPreflightResult {
  passed: boolean
  checks: JevPreflightCheck[]
  failed: string[]
}

export interface JevPreflightOptions {
  jevService?: {
    preflight(): Promise<{ ok: boolean; model: string | null; failure: { class: string; message: string } | null }>
  }
  getApiKey?: () => string | null
  now?: number
  envFilePath?: string | null
}

function defaultApiKey(): string | null {
  try {
    return env.get('TYPESAFE_API_KEY', '') || null
  } catch {
    return null
  }
}

function secretFileReadableByOthers(path: string | null | undefined): boolean | null {
  if (!path) return null
  try {
    const mode = fs.statSync(path).mode & 0o777
    return (mode & 0o077) !== 0
  } catch {
    return null
  }
}

export async function runJevPreflight(opts: JevPreflightOptions = {}): Promise<JevPreflightResult> {
  const checks: JevPreflightCheck[] = []
  const push = (layer: JevPreflightCheck['layer'], name: string, ok: boolean, detail?: string) =>
    checks.push({ layer, name, ok, detail })

  const getApiKey = opts.getApiKey ?? defaultApiKey
  const key = getApiKey()
  push('environment', 'key-present', !!key, key ? undefined : 'TYPESAFE_API_KEY unset')

  const perms = secretFileReadableByOthers(opts.envFilePath ?? null)
  push(
    'environment',
    'secret-file-permissions',
    perms === null || !perms,
    perms === null ? 'no env file path supplied — skipped' : perms ? 'env file readable beyond owner' : undefined
  )

  const unacked = await OperationAlert.unacknowledged('jev')
  push('local', 'no-unacknowledged-alerts', unacked.length === 0, unacked.length ? `${unacked.length} unacknowledged` : undefined)

  if (key) {
    try {
      const scorer = opts.jevService
      if (!scorer) {
        push('venue', 'scorer-live', false, 'no scorer supplied')
      } else {
        const proof = await scorer.preflight()
        push('venue', 'scorer-live', proof.ok, proof.ok ? `model=${proof.model}` : (proof.failure?.message ?? 'preflight failed'))
        push(
          'venue',
          'model-pinned',
          proof.ok && proof.model === JEV_MODEL_ID,
          proof.ok && proof.model !== JEV_MODEL_ID ? `responding model ${proof.model} differs from pinned ${JEV_MODEL_ID}` : undefined
        )
      }
    } catch (error) {
      push('venue', 'scorer-live', false, error instanceof Error ? error.message : String(error))
      push('venue', 'model-pinned', false, 'scorer unreachable')
    }
  } else {
    push('venue', 'scorer-live', false, 'skipped without a credential')
    push('venue', 'model-pinned', false, 'skipped without a credential')
  }

  const failed = checks.filter((c) => !c.ok).map((c) => c.name)
  return { passed: failed.length === 0, checks, failed }
}

export async function recordJevPreflightPass(result: JevPreflightResult, now = Date.now()): Promise<void> {
  await ControlRecord.setState(
    JEV_PREFLIGHT_CONTROL_NAME,
    result.passed ? 'passed' : 'failed',
    { passed: result.passed, failed: result.failed, at: now },
    { heartbeatAt: now }
  )
}

export async function isJevPreflightFresh(now = Date.now(), ttlMs: number = JEV_PREFLIGHT_TTL_MS): Promise<boolean> {
  return isPreflightFresh(await ControlRecord.get(JEV_PREFLIGHT_CONTROL_NAME), now, ttlMs)
}
