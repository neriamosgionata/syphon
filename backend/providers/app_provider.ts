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
 * Application provider. The `shutdown` hook tears down the BullMQ workers
 * and queues so the process can exit cleanly.
 */
export default class AppProvider {
  constructor(protected app: ApplicationService) {}

  register() {}

  async boot() {}

  async ready() {}

  async shutdown() {
    const { default: QueueService } = await import('#jobs/QueueService')
    await QueueService.shutdown()
  }
}
