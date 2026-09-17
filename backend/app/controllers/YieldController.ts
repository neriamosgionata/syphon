import OperationAlert from '#models/OperationAlert'
import { buildYieldStatus } from '#services/YieldReport'

// Read-only yield surface. No mutating action is reachable over HTTP — the
// CLI owns every mutation (KTD11).

export default class YieldController {
  public async status(): Promise<Record<string, any>> {
    return buildYieldStatus()
  }

  /** Alert payloads carry only source/severity/code/message — never balances or payloads. */
  public async alerts(): Promise<Record<string, any>> {
    const alerts = await OperationAlert.query().orderBy('created_at', 'desc').limit(50)
    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        source: alert.source,
        severity: alert.severity,
        code: alert.code,
        message: alert.message,
        created_at: alert.createdAt,
        acknowledged_at: alert.acknowledgedAt,
      })),
    }
  }
}
