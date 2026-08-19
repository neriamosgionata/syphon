import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import NotificationService, { AppNotification } from '#services/NotificationService'

export default class NotificationsController {
  public async stream({ response }: HttpContext) {
    response.response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Send initial connection event
    response.response.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to notifications' })}\n\n`)

    const listener = (notification: AppNotification) => {
      response.response.write(`event: ${notification.type}\ndata: ${JSON.stringify(notification)}\n\n`)
    }

    const unsubscribe = NotificationService.subscribe(listener)

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      response.response.write(': ping\n\n')
    }, 30_000)

    // Cleanup on disconnect
    response.response.on('close', () => {
      logger.debug('[Notifications] SSE client disconnected')
      clearInterval(keepAlive)
      unsubscribe()
    })
  }
}
