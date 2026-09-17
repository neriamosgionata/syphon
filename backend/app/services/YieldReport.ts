// ─── Yield status + report ─────────────────────────────────────
//
// Status assembles the operator view (allocations, pending operations,
// realized rewards, skip reasons, heartbeat staleness, alerts) from the
// persisted tables — no SSE, no in-process state. The report export is a
// CSV of ledger-reconciled reward rows in native units.

import YieldAllocation from '#models/YieldAllocation'
import YieldReward from '#models/YieldReward'
import OperationIntent from '#models/OperationIntent'
import OperationAlert from '#models/OperationAlert'
import ControlRecord from '#models/ControlRecord'
import YieldAccounting from '#services/YieldAccounting'
import {
  DEFAULT_PREFLIGHT_TTL_MS,
  ONE_TICK_MS,
  PREFLIGHT_CONTROL_NAME,
  isPreflightFresh,
} from '#services/YieldPreflight'

export interface YieldStatus {
  lastTick: { at: number | null; stale: boolean; detail: Record<string, any> | null }
  preflight: { state: string | null; at: number | null; fresh: boolean }
  allocations: Array<Record<string, any>>
  openOperations: Array<Record<string, any>>
  realized: Array<{ asset: string; amount: number; rewards: number }>
  recentAlerts: Array<Record<string, any>>
}

export async function buildYieldStatus(now = Date.now()): Promise<YieldStatus> {
  const lastTick = await ControlRecord.get('yield:tick')
  const preflight = await ControlRecord.get(PREFLIGHT_CONTROL_NAME)
  const allocations = await YieldAllocation.all()
  const openOperations = await OperationIntent.query()
    .whereIn('status', ['pending', 'submitted'])
    .orderBy('created_at', 'desc')
  const alerts = await OperationAlert.query().orderBy('created_at', 'desc').limit(20)
  const realized = await YieldAccounting.realizedByAsset(now - 30 * 86_400_000, now)

  return {
    lastTick: {
      at: lastTick?.heartbeatAt ?? null,
      stale: ControlRecord.isRowStale(lastTick, now, 2 * ONE_TICK_MS),
      detail: lastTick?.detail ?? null,
    },
    preflight: {
      state: preflight?.state ?? null,
      at: preflight?.heartbeatAt ?? null,
      fresh: isPreflightFresh(preflight, now, DEFAULT_PREFLIGHT_TTL_MS),
    },
    allocations: allocations.map((row) => ({
      strategyId: row.strategyId,
      asset: row.asset,
      lockType: row.lockType,
      canAllocate: row.canAllocate,
      allocatedNative: row.allocatedNative,
      pendingNative: row.pendingNative,
      unbondingNative: row.unbondingNative,
      unbondingExpiresAt:
        row.unbondingSeconds && row.lastRefreshedAt
          ? row.lastRefreshedAt + row.unbondingSeconds * 1000
          : null,
      apyLow: row.apyLow,
      apyHigh: row.apyHigh,
      estimatedMonthlyRewardNative:
        row.apyLow !== null ? (row.allocatedNative * row.apyLow) / 12 : null,
      lastRefreshedAt: row.lastRefreshedAt,
    })),
    openOperations: openOperations.map((intent) => ({
      id: intent.id,
      strategyId: intent.strategyId,
      type: intent.type,
      status: intent.status,
      createdAt: intent.createdAt,
      refid: intent.refid,
    })),
    realized: realized.map((entry) => ({ asset: entry.asset, amount: entry.amount, rewards: entry.rewards })),
    recentAlerts: alerts.map((alert) => ({
      id: alert.id,
      source: alert.source,
      severity: alert.severity,
      code: alert.code,
      message: alert.message,
      createdAt: alert.createdAt,
      acknowledgedAt: alert.acknowledgedAt,
    })),
  }
}

/** CSV for tax/accounting export. Native units only — no EUR valuation. */
export function buildYieldReportCsv(rows: YieldReward[]): string {
  const lines = [
    '# Kraken Earn reward export — native units only',
    '# EUR fair-value valuation and tax treatment are NOT applied.',
    'time_iso,refid,asset,amount,ledger_type,subtype,strategy_id',
  ]
  for (const row of rows) {
    lines.push(
      [
        new Date(row.time).toISOString(),
        row.refid,
        row.asset,
        row.amount,
        row.ledgerType,
        row.subtype ?? '',
        row.strategyId ?? '',
      ].join(',')
    )
  }
  return lines.join('\n') + '\n'
}
