import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import MeilisearchService from '#services/MeilisearchService'
import { DateTime } from 'luxon'
import os from 'os'

/**
 * Hook into the pino-based logger to capture all log entries
 * and forward them to Meilisearch.
 *
 * Skipped in the test environment: tests boot the same preloads and a
 * buffered flush can race with specs that stub `globalThis.fetch`
 * (it would push log docs through the stub and break fetch-call assertions).
 */
function setupLogForwarder() {
  if (env.get('NODE_ENV') === 'test') return

  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
  const hostname = os.hostname()
  const pid = process.pid

  for (const level of levels) {
    const original = (logger as any)[level]?.bind(logger)
    if (!original) continue

    ;(logger as any)[level] = function (...args: any[]) {
      // Call original logger
      original(...args)

      // Extract message
      let message = ''
      let context: string | undefined
      let data: any

      if (typeof args[0] === 'string') {
        // Format string pattern: logger.info('message %s', val)
        message = args[0]
        const formatArgs = args.slice(1)
        let argIdx = 0
        message = message.replace(/%[sdjfo%]/g, (match) => {
          if (match === '%%') return '%'
          if (argIdx >= formatArgs.length) return match
          return String(formatArgs[argIdx++])
        })
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        data = args[0]
        message = args[1] || ''
      }

      // Extract context from message patterns like [FetchTicker], [BulkSync], etc.
      const ctxMatch = message.match(/^\[([^\]]+)\]/)
      if (ctxMatch) context = ctxMatch[1]

      const levelNumber = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level] || 30

      MeilisearchService.pushLog({
        timestamp: DateTime.now().toISO()!,
        level,
        levelNumber,
        message,
        context,
        hostname,
        pid,
        data: data || undefined,
      })
    }
  }
}

setupLogForwarder()