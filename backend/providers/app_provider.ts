import env from '#start/env'
import type { ApplicationService } from '@adonisjs/core/types'
import { BaseModel, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm'
import { SimplePaginator } from '@adonisjs/lucid/database'

/**
 * Adonis 7 / lucid v22 defaults to camelCase model serialization (both the
 * JSON output of `toJSON()` and the paginator meta keys). The v5 API contract
 * — and the frontend consuming it — uses snake_case everywhere. Restore the
 * snake_case naming strategy before any model class is defined so column
 * decorators compute the right serialized names.
 */
;(BaseModel as any).namingStrategy = new SnakeCaseNamingStrategy()
;(SimplePaginator as any).namingStrategy = new SnakeCaseNamingStrategy()

/**
 * Application provider. `boot` fails closed when a mutating income line is
 * enabled on a non-loopback bind; `shutdown` tears down the BullMQ workers
 * and queues so the process can exit cleanly.
 */
export default class AppProvider {
  constructor(protected app: ApplicationService) {}

  register() {}

  async boot() {
    const { assertIncomeBindSafe } = await import('#services/income_bind_guard')
    // Jev overlay liveness is a persisted stage (async read, fail-open
    // false — a boot without a readable DB is broken elsewhere anyway).
    let jevLive = false
    try {
      const [{ default: JevRollout }, { default: AlgoConfig }, { isJevPreflightFresh }] = await Promise.all([
        import('#services/JevRollout'),
        import('#models/AlgoConfig'),
        import('#services/JevPreflight'),
      ])
      const [stage, latched, cfg] = await Promise.all([
        JevRollout.getStage().catch(() => 'shadow' as const),
        JevRollout.isLatched().catch(() => true),
        AlgoConfig.getConfig().catch(() => null),
      ])
      const gateEnabled = !!cfg?.fastJevGateEnabled
      const shadowOnly = cfg?.fastJevShadowOnly ?? true
      const freshPreflight =
        stage === 'live' ? await isJevPreflightFresh(Date.now()).catch(() => false) : false
      jevLive = stage !== 'shadow' && !latched && gateEnabled && !shadowOnly && (stage === 'live' ? freshPreflight : true)
    } catch {
      jevLive = false
    }
    assertIncomeBindSafe(env.get('HOST', ''), {
      yieldLive: env.get('YIELD_LIVE', false) === true,
      // The trend evaluation is paper-only (no order path exists): it is
      // never a mutating line under the current wiring.
      trendLive: false,
      jevLive,
    })
  }

  async ready() {}

  async shutdown() {
    const { default: QueueService } = await import('#jobs/QueueService')
    await QueueService.shutdown()
  }
}
