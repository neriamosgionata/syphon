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
    // Close every open handle (BullMQ queues/workers, Redis, DB, Binance WS)
    // so the process can exit once the suite finishes. Without this, the 7
    // BullMQ queue connections, the Redis service connection and the Binance
    // WebSocket reconnect loop keep the test process alive forever.
    async () => {
      await app.terminate()
      try {
        const { default: redis } = await import('@adonisjs/redis/services/main')
        await redis.quitAll()
      } catch {
        /* noop */
      }
      // The `POST /api/fast/subscribe` test calls BinanceWS.addSymbol, which
      // opens a real Binance WebSocket and schedules auto-reconnects. Tear it
      // down so the reconnect loop doesn't keep the process alive.
      try {
        const { default: BinanceWS } = await import('#services/BinanceWebSocketService')
        BinanceWS.disconnect()
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
