import 'reflect-metadata'
import { join } from 'path'
import getPort from 'get-port'
import { configure, processCliArgs, run } from '@japa/runner'
import { specReporter } from '@japa/spec-reporter'
import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import sourceMapSupport from 'source-map-support'

sourceMapSupport.install({ handleUncaughtExceptions: false })

export let app: any

async function startHttpServer() {
  const { Ignitor } = await import('@adonisjs/core/build/standalone')
  const ignitor = new Ignitor(join(__dirname, '..'))

  app = ignitor.application()
  await app.setup()
  await app.registerProviders()
  await app.bootProviders()
  await app.requirePreloads()
  await app.start()

  const port = await getPort()
  process.env.PORT = String(port)
  process.env.HOST = '0.0.0.0'
  process.env.NODE_ENV = 'test'

  const server = app.container.use('Adonis/Core/Server')
  const httpServer = require('http').createServer(server.handle.bind(server))

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => resolve())
  })

  return `http://0.0.0.0:${port}`
}

async function runTests() {
  let baseUrl = ''

  configure({
    ...processCliArgs(process.argv.slice(2)),
    suites: [
      {
        name: 'unit',
        files: ['tests/unit/**/*.spec.ts'],
        timeout: 10000,
      },
      {
        name: 'functional',
        files: ['tests/functional/**/*.spec.ts'],
        timeout: 30000,
        setup: [
          async () => {
            baseUrl = await startHttpServer()
            return async () => {
              await app?.shutdown()
            }
          },
        ],
      },
    ],
    plugins: [
      assert(),
      apiClient(() => baseUrl),
    ],
    reporters: [specReporter()],
    importer: (filePath) => import(filePath),
  })

  await run()
}

runTests()
