import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * The API only ever returns JSON — force the Accept header so the content
 * negotiation always resolves to the JSON responder (replaces the v5
 * `forceContentNegotiationTo` option).
 */
export default class ForceJsonResponseMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    ctx.request.request.headers.accept = 'application/json'
    return next()
  }
}