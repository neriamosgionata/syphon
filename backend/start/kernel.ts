import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

/**
 * The error handler is used to convert an exception
 * to a HTTP response.
 */
server.errorHandler(() => import('#exceptions/Handler'))

/**
 * The server middleware stack runs middleware on all the HTTP
 * requests, even if there is no route registered for
 * the request URL.
 */
server.use([
  () => import('#middleware/ContainerBindings'),
  () => import('#middleware/ForceJsonResponse'),
  () => import('@adonisjs/cors/cors_middleware'),
])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
])

/**
 * Named middleware: applied per-route. `loopbackOnly` gates the income
 * endpoints — they are read-only and must not be reachable remotely.
 */
export const middleware = router.named({
  loopbackOnly: () => import('#middleware/loopback_only_middleware'),
})