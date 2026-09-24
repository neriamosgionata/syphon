import type { HttpContext } from '@adonisjs/core/http'

// The income lines' HTTP surface is read-only and loopback-only. This
// middleware rejects any request that does not originate from the loopback
// interface, even if the operator later widens the server bind.

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export default class LoopbackOnlyMiddleware {
  public async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    const ip = ctx.request.ip()
    if (!LOOPBACK_ADDRESSES.has(ip)) {
      ctx.response.forbidden({ error: 'income endpoints are loopback-only' })
      return
    }
    await next()
  }
}
