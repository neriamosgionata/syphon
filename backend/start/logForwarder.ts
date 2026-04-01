import Logger from '@ioc:Adonis/Core/Logger'
import MeilisearchService from 'App/Services/MeilisearchService'
import { DateTime } from 'luxon'
import os from 'os'

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

/**
 * Hook into pino's underlying stream to capture all log entries
 * and forward them to Meilisearch
 */
function setupLogForwarder() {
  const pino = (Logger as any).pino || (Logger as any)['$logger']
  if (!pino) return

  // Get the underlying writable stream
  const originalWrite = pino.stream?.write || pino[Symbol.for('pino.stream')]?.write
  if (!originalWrite) {
    // Alternative: use pino's child logger hook
    const origChild = pino.child?.bind(pino)
    if (!origChild) return
  }

  // Use a simpler approach: poll by overriding the pino instance methods
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
  const hostname = os.hostname()
  const pid = process.pid

  for (const level of levels) {
    const original = (Logger as any)[level]?.bind(Logger)
    if (!original) continue

    ;(Logger as any)[level] = function (...args: any[]) {
      // Call original logger
      original(...args)

      // Extract message
      let message = ''
      let context: string | undefined
      let data: any

      if (typeof args[0] === 'string') {
        // Format string pattern: Logger.info('message %s', val)
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
