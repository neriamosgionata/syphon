import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Unit specs exercise lucid models (FastAlgoService, AlgoConfig, ...).
 * Point the SQLite connection at a throwaway file so the dev database
 * (syphon.sqlite3, live trading rows!) is never touched. Must happen at
 * module scope: config/database.ts reads SQLITE_FILENAME during app boot,
 * which occurs after this module is imported (bin/test.ts imports it in the
 * ace configure phase). process.env wins over .env in @adonisjs/env.
 */
const UNIT_DB_FILE =
  process.env.TEST_SUITE === 'unit'
    ? path.join(os.tmpdir(), `syphon-unit-${process.pid}.sqlite`)
    : null

if (UNIT_DB_FILE) {
  process.env.SQLITE_FILENAME = UNIT_DB_FILE
}

export const plugins: Config['plugins'] = [
  assert(),
  pluginAdonisJS(app),
  apiClient(),
]

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [
    ...(UNIT_DB_FILE
      ? [
          async () => {
            // Fresh schema for the throwaway DB (runs all migrations).
            await testUtils.db().migrate()
          },
        ]
      : []),
  ],
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
      // Remove the throwaway DB (plus WAL/SHM sidecars).
      if (UNIT_DB_FILE) {
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            fs.rmSync(`${UNIT_DB_FILE}${suffix}`, { force: true })
          } catch {
            /* noop */
          }
        }
      }
    },
  ],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (suite.name === 'functional') {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
