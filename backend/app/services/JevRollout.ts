import ControlRecord from '#models/ControlRecord'
import OperationAlert from '#models/OperationAlert'

// ─── Jev rollout stage machine (U6) ──────────────────────────────
//
// shadow → veto_only → live, one step at a time, recorded in `control`
// rows (no schema change). Standing down is always allowed; promotion
// needs a clear alert board. A latching tripwire drops enforcement back
// to deterministic-only until an explicit resume re-enters shadow —
// alerts themselves stay for the CLI-only `alerts:ack` path.

export type JevStage = 'shadow' | 'veto_only' | 'live'

export const JEV_STAGE_CONTROL = 'jev:stage'
export const JEV_LATCH_CONTROL = 'jev:latch'

const ORDER: Record<JevStage, number> = { shadow: 0, veto_only: 1, live: 2 }

export default class JevRollout {
  public static async getStage(): Promise<JevStage> {
    const row = await ControlRecord.get(JEV_STAGE_CONTROL)
    const state = row?.state
    return state === 'veto_only' || state === 'live' ? state : 'shadow'
  }

  public static async isLatched(): Promise<boolean> {
    const row = await ControlRecord.get(JEV_LATCH_CONTROL)
    return !!row && row.state === 'latched'
  }

  public static async isEnforcing(): Promise<boolean> {
    const [stage, latched] = await Promise.all([this.getStage(), this.isLatched()])
    return !latched && stage !== 'shadow'
  }

  public static async setStage(stage: JevStage, reason: string): Promise<{ ok: boolean; error?: string }> {
    const current = await this.getStage()
    if (stage === current) return { ok: true }
    if (ORDER[stage] < ORDER[current]) {
      await ControlRecord.setState(JEV_STAGE_CONTROL, stage, { reason, at: Date.now() })
      return { ok: true }
    }
    if (ORDER[stage] > ORDER[current] + 1) {
      return { ok: false, error: `refusing jump from ${current} to ${stage}: promote through veto_only first` }
    }
    const unacked = await OperationAlert.unacknowledged('jev')
    if (unacked.length > 0) {
      return { ok: false, error: `refusing promotion with ${unacked.length} unacknowledged jev alert(s)` }
    }
    await ControlRecord.setState(JEV_STAGE_CONTROL, stage, { reason, at: Date.now() })
    return { ok: true }
  }

  public static async latchOff(reason: string): Promise<void> {
    await ControlRecord.setState(JEV_LATCH_CONTROL, 'latched', { reason, at: Date.now() })
    await OperationAlert.raise({ source: 'jev', severity: 'critical', code: 'jev-latched', message: reason })
  }

  public static async resume(reason: string): Promise<void> {
    await ControlRecord.setState(JEV_STAGE_CONTROL, 'shadow', { reason, at: Date.now() })
    await ControlRecord.setState(JEV_LATCH_CONTROL, 'clear', { reason, at: Date.now() })
  }

  /**
   * Latching tripwire (U6): a calibration breach or two consecutive
   * negative evaluation periods drops enforcement. One bad period is
   * noise — it records nothing and latches nothing.
   */
  public static async evaluateTripwire(input: {
    consecutiveNegativePeriods: number
    calibrationBreach: boolean
  }): Promise<{ latched: boolean }> {
    if (input.calibrationBreach) {
      await this.latchOff('jev calibration breach')
      return { latched: true }
    }
    if (input.consecutiveNegativePeriods >= 2) {
      await this.latchOff(`jev ${input.consecutiveNegativePeriods} consecutive negative evaluation periods`)
      return { latched: true }
    }
    return { latched: false }
  }
}
