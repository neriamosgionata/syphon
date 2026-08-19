import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/core/http'

/**
 * The app URL can be used in various places where you want to create absolute
 * URLs to your application.
 */
export const appUrl = env.get('APP_URL', '')

/**
 * The configuration settings used by the HTTP server
 */
export const http = defineConfig({
  /**
   * Generate a unique request id for each incoming request.
   * Useful to correlate logs and debug a request flow.
   */
  generateRequestId: false,

  /**
   * Allow HTTP method spoofing via the "_method" form/query parameter.
   */
  allowMethodSpoofing: false,

  /**
   * Enabling async local storage will let you access HTTP context
   * from anywhere inside your application.
   */
  useAsyncLocalStorage: false,

  /**
   * Trust all proxies. The application is served behind a reverse proxy
   * in production.
   */
  trustProxy: (_address: string) => true,

  /**
   * Disable ETag generation (the API returns JSON payloads directly).
   */
  etag: false,

  /**
   * Default JSONP callback name.
   */
  jsonpCallbackName: 'callback',

  /**
   * Redirect configuration controls the behavior of
   * response.redirect().back() and query string forwarding.
   */
  redirect: {
    forwardQueryString: true,
  },

  /**
   * Manage cookies configuration.
   */
  cookie: {
    domain: '',
    path: '/',
    maxAge: '2h',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },
})