import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import YieldController from '../../app/controllers/YieldController.js'
import TrendController from '../../app/controllers/TrendController.js'
import LoopbackOnlyMiddleware from '../../app/middleware/loopback_only_middleware.js'
import { assertIncomeBindSafe } from '../../app/services/income_bind_guard.js'
import OperationAlert from '../../app/models/OperationAlert.js'
import ControlRecord from '../../app/models/ControlRecord.js'
import YieldAllocation from '../../app/models/YieldAllocation.js'
import YieldReward from '../../app/models/YieldReward.js'
import TrendEvaluation from '../../app/models/TrendEvaluation.js'
import TrendConfig from '../../app/models/TrendConfig.js'

// Operator surface: read-only controller payloads, loopback enforcement,
// fail-closed bind guard, and the absence of mutating income routes.

test.group('operator surface', (group) => {
  group.each.setup(async () => {
    await OperationAlert.query().delete()
    await ControlRecord.query().delete()
    await YieldAllocation.query().delete()
    await YieldReward.query().delete()
    await TrendEvaluation.query().delete()
    await TrendConfig.query().delete()
  })

  test('controllers return well-formed empty states on a fresh database', async ({ assert }) => {
    const yieldStatus = await new YieldController().status()
    assert.isArray(yieldStatus.allocations)
    assert.lengthOf(yieldStatus.allocations, 0)
    assert.isTrue(yieldStatus.lastTick.stale)
    assert.equal(yieldStatus.preflight.state, null)
    assert.deepEqual(yieldStatus.realized, [])

    const alerts = await new YieldController().alerts()
    assert.deepEqual(alerts.alerts, [])

    const trendStatus = await new TrendController().status()
    assert.deepEqual(trendStatus.evaluations, [])
    assert.equal(trendStatus.trip.state, 'ok')
  })

  test('stale heartbeats and unacknowledged alerts appear with redacted fields only', async ({ assert }) => {
    const now = Date.now()
    await ControlRecord.tryAcquire('yield:tick', 'test', 60_000, now - 3 * 3600_000)
    await ControlRecord.release('yield:tick', 'test')
    await OperationAlert.raise({
      source: 'yield',
      severity: 'warning',
      code: 'reconcile-mismatch',
      message: 'strategy ES-ETH-1 local rewards differ from the venue ledger',
      now,
    })

    const status = await new YieldController().status()
    assert.isTrue(status.lastTick.stale)
    assert.isAtLeast(status.recentAlerts.length, 1)

    const alerts = await new YieldController().alerts()
    assert.lengthOf(alerts.alerts, 1)
    assert.isNull(alerts.alerts[0].acknowledged_at)
    assert.deepEqual(
      Object.keys(alerts.alerts[0]).sort(),
      ['acknowledged_at', 'code', 'created_at', 'id', 'message', 'severity', 'source']
    )
  })

  test('the loopback middleware rejects remote addresses and passes loopback', async ({ assert }) => {
    const middleware = new LoopbackOnlyMiddleware()

    let forbidden: any = null
    let nextCalled = false
    await middleware.handle(
      {
        request: { ip: () => '10.0.0.5' },
        response: { forbidden: (body: any) => { forbidden = body } },
      } as any,
      async () => { nextCalled = true }
    )
    assert.isFalse(nextCalled)
    assert.deepEqual(forbidden, { error: 'income endpoints are loopback-only' })

    let localNext = false
    await middleware.handle(
      {
        request: { ip: () => '127.0.0.1' },
        response: { forbidden: () => { throw new Error('must not be called') } },
      } as any,
      async () => { localNext = true }
    )
    assert.isTrue(localNext)
  })

  test('a non-loopback bind with an enabled income line refuses to start', ({ assert }) => {
    assert.throws(() => assertIncomeBindSafe('0.0.0.0', { yieldLive: true, trendLive: false }))
    assert.throws(() => assertIncomeBindSafe('0.0.0.0', { yieldLive: false, trendLive: true }))

    assert.doesNotThrow(() => assertIncomeBindSafe('127.0.0.1', { yieldLive: true, trendLive: true }))
    assert.doesNotThrow(() => assertIncomeBindSafe('0.0.0.0', { yieldLive: false, trendLive: false }))
  })

  test('no mutating yield or trend route exists', ({ assert }) => {
    const routes = fs.readFileSync(path.join(process.cwd(), 'start', 'routes.ts'), 'utf8')

    assert.notMatch(routes, /router\.(post|put|patch|delete)\(\s*['"][^'"]*\/(yield|trend)/)
    assert.include(routes, `'/yield/status'`)
    assert.include(routes, `'/yield/alerts'`)
    assert.include(routes, `'/trend/status'`)
    assert.include(routes, 'loopbackOnly()')
  })
})
