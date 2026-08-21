/*
|--------------------------------------------------------------------------
| Test runner entrypoint
|--------------------------------------------------------------------------
|
| The "test.ts" file is the entrypoint for running tests using Japa.
|
| Either you can run this file directly or use the "test"
| command to run this file and monitor file changes.
|
*/

process.env.NODE_ENV = 'test'

// Point the SQLite connection at a throwaway file BEFORE the app boots:
// @adonisjs/env captures process.env values at app init, so this must run
// before the Ignitor is created. Keeps unit tests (which exercise lucid
// models) off the dev database (syphon.sqlite3 holds live trading rows).
// Note: bun auto-loads backend/.env into process.env at startup, so the
// value must be OVERWRITTEN unconditionally.
// tests/bootstrap.ts runs the migrations on the throwaway DB and removes it
// during teardown.
if (process.env.TEST_SUITE === 'unit') {
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.SQLITE_FILENAME = join(tmpdir(), `syphon-unit-${process.pid}.sqlite`)
}

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'

/**
 * URL to the application root. AdonisJS need it to resolve
 * paths to file and directories for scaffolding commands
 */
const APP_ROOT = new URL('../', import.meta.url)

/**
 * The importer is used to import files in context of the
 * application.
 */
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .testRunner()
  .configure(async (app) => {
    const { runnerHooks, ...config } = await import('../tests/bootstrap.js')

    processCLIArgs(process.argv.splice(2))

    /**
     * The unit and functional suites boot the real application in the same
     * process (and share module singletons for Env/Models/Redis/Db), so they
     * must not run together. TEST_SUITE pins a single suite per process —
     * the npm scripts run them as separate processes to preserve isolation.
     */
    const suites = (app.rcFile.tests?.suites ?? []).filter((suite) => {
      if (process.env.TEST_SUITE) return suite.name === process.env.TEST_SUITE
      return true
    })

    configure({
      ...app.rcFile.tests,
      suites,
      ...config,
      ...{
        setup: runnerHooks.setup,
        teardown: runnerHooks.teardown.concat([() => app.terminate()]),
      },
    })
  })
  .run(() => run())
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })