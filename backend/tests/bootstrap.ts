import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'

export const plugins: Config['plugins'] = [
  assert(),
  pluginAdonisJS(app),
  apiClient(),
]

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [],
  teardown: [
    // Close every open handle (BullMQ queues/workers, Redis, DB, Kraken WS)
    // so the process can exit once the suite finishes. Without this, the
    // BullMQ queue connections, the Redis service connection and the Kraken
    // WebSocket reconnect loop keep the test process alive forever.
    async () => {
      await app.terminate()
      try {
        const { default: redis } = await import('@adonisjs/redis/services/main')
        await redis.quitAll()
      } catch {
        /* noop */
      }
      // FastAlgoService/KrakenWS may have opened a real Kraken WebSocket and
      // scheduled auto-reconnects. Tear it down so the reconnect loop doesn't
      // keep the process alive.
      try {
        const { default: KrakenWS } = await import('#services/KrakenWebSocketService')
        KrakenWS.disconnect()
      } catch {
        /* noop */
      }
    },
  ],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (suite.name === 'functional') {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
