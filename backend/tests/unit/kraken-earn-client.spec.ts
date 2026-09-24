import { test } from '@japa/runner'
import { KrakenEarnClient, KrakenEarnError } from '../../app/services/KrakenEarnClient.js'
import { KrakenService } from '../../app/services/KrakenService.js'
import env from '../../start/env.js'

// Kraken Earn client: dedicated credentials, typed errors, no secret material
// in logs or returned values. All venue traffic is stubbed via global fetch or
// an injected signed-request seam — no network.

const EARN_KEY = 'earn-test-key-001'
const EARN_SECRET = Buffer.from('test-secret').toString('base64')

// Vectors computed independently from the documented Kraken signature
// algorithm (HMAC-SHA512 of uriPath + SHA256(nonce + body), base64 secret).
const STRATEGIES_SIGNATURE_VECTOR =
  'dncCi/BVIDiq+UIx5c2DcCpUwqGyK8h3YjYFxHMbCBz9tXsjSoyGdMnofsoZ47v6hjf9nQasgFwURvDGmdC7JA=='
const ALLOCATE_SIGNATURE_VECTOR =
  'psB4l1LdgvbtSiOPiSrKvBJIiJJ9G42E+aFpnuu8FozOfocX10T4yE3xN8lVglm5aTsbS4kKnF8ztcQUkNGGtQ=='

const originalFetch = globalThis.fetch

function silentLogger() {
  const lines: string[] = []
  return { lines, logger: { warn: (message: string) => lines.push(message) } }
}

async function captureError(fn: () => Promise<any>): Promise<any> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  return null
}

function jsonResponse(body: any, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
}

test.group('KrakenEarnClient signing', (group) => {
  group.each.teardown(() => {
    ;(globalThis as any).fetch = originalFetch
  })

  test('produces the hardcoded signature vector for a fixed nonce', async ({ assert }) => {
    const originalNow = Date.now
    Date.now = () => 1000
    let captured: any = null
    ;(globalThis as any).fetch = async (_url: string, init: any) => {
      captured = init
      return jsonResponse({ result: { items: {} }, error: [] })
    }

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })
      await client.getStrategies()

      assert.equal(captured.headers['API-Sign'], STRATEGIES_SIGNATURE_VECTOR)
      assert.equal(captured.body, 'nonce=1000000')
    } finally {
      Date.now = originalNow
    }
  })

  test('signs allocation parameters in body order', async ({ assert }) => {
    const originalNow = Date.now
    Date.now = () => 1000
    let captured: any = null
    ;(globalThis as any).fetch = async (_url: string, init: any) => {
      captured = init
      return jsonResponse({ result: { refid: 'OP-1' }, error: [] })
    }

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })
      const result = await client.allocate('ES123', 1.5)

      assert.equal(result.refid, 'OP-1')
      assert.equal(captured.headers['API-Sign'], ALLOCATE_SIGNATURE_VECTOR)
      assert.equal(captured.body, 'nonce=1000000&strategy_id=ES123&amount=1.5')
    } finally {
      Date.now = originalNow
    }
  })

  test('refuses to sign when credentials are unset or shared with the spot key', async ({ assert }) => {
    let fetchCalls = 0
    ;(globalThis as any).fetch = async () => {
      fetchCalls++
      throw new Error('fetch must not be called')
    }

    const unset = new KrakenEarnClient({ key: '', secret: '', logger: silentLogger().logger })
    const unsetError = await captureError(() => unset.getStrategies())
    assert.instanceOf(unsetError, KrakenEarnError)
    assert.equal(unsetError.code, 'credentials')

    const spotKey = env.get('KRAKEN_API_KEY', '')
    const spotSecret = env.get('KRAKEN_API_SECRET', '')
    const shared = new KrakenEarnClient({
      key: spotKey || 'spot-key',
      secret: spotKey ? EARN_SECRET : spotSecret || 'spot-secret',
      logger: silentLogger().logger,
    })
    const sharedError = await captureError(() => shared.getStrategies())
    assert.instanceOf(sharedError, KrakenEarnError)
    assert.equal(sharedError.code, 'credentials')

    assert.equal(fetchCalls, 0)
  })

  test('resolves distinct credentials', ({ assert }) => {
    const client = new KrakenEarnClient({ key: EARN_KEY, secret: EARN_SECRET })
    assert.deepEqual(client.resolveCredentials(), { key: EARN_KEY, secret: EARN_SECRET })
  })
})

test.group('KrakenEarnClient errors', () => {
  test('missing Earn Funds permission is a typed permission error with no key material', async ({ assert }) => {
    const { logger } = silentLogger()
    const service = {
      signedRequest: async () => {
        throw new Error('EGeneral:Permission denied')
      },
    }
    const client = new KrakenEarnClient({ key: EARN_KEY, secret: EARN_SECRET, service, logger })

    const error = await captureError(() => client.getStrategies())
    assert.instanceOf(error, KrakenEarnError)
    assert.equal(error.code, 'permission')
    assert.notInclude(error.message, EARN_KEY)
    assert.notInclude(error.message, EARN_SECRET)
  })

  test('retries a transport failure once, then surfaces a transport error', async ({ assert }) => {
    let calls = 0
    const service = {
      signedRequest: async () => {
        calls++
        throw new TypeError('fetch failed')
      },
    }
    const { logger } = silentLogger()
    const client = new KrakenEarnClient({
      key: EARN_KEY,
      secret: EARN_SECRET,
      service,
      logger,
      retryBackoffMs: 1,
      delay: async () => {},
    })

    const error = await captureError(() => client.getStrategies())
    assert.instanceOf(error, KrakenEarnError)
    assert.equal(error.code, 'transport')
    assert.equal(calls, 2)
  })

  test('retries a 5xx once and succeeds on the second attempt', async ({ assert }) => {
    let calls = 0
    const service = {
      signedRequest: async () => {
        calls++
        if (calls === 1) throw new Error('Kraken HTTP 503')
        return { items: {} }
      },
    }
    const { logger } = silentLogger()
    const client = new KrakenEarnClient({
      key: EARN_KEY,
      secret: EARN_SECRET,
      service,
      logger,
      retryBackoffMs: 1,
      delay: async () => {},
    })

    const strategies = await client.getStrategies()
    assert.deepEqual(strategies, [])
    assert.equal(calls, 2)
  })

  test('deterministic venue errors never retry', async ({ assert }) => {
    let calls = 0
    const service = {
      signedRequest: async () => {
        calls++
        throw new Error('EAPI:Invalid key')
      },
    }
    const { logger } = silentLogger()
    const client = new KrakenEarnClient({
      key: EARN_KEY,
      secret: EARN_SECRET,
      service,
      logger,
      retryBackoffMs: 1,
      delay: async () => {},
    })

    const error = await captureError(() => client.getStrategies())
    assert.instanceOf(error, KrakenEarnError)
    assert.equal(error.code, 'permission')
    assert.equal(calls, 1)
  })

  test('redacts key material from logs and error surfaces of a fully signed call', async ({ assert }) => {
    const captured: string[] = []
    let signedHeader = ''
    let signedBody = ''
    ;(globalThis as any).fetch = async (_url: string, init: any) => {
      signedHeader = init.headers['API-Sign']
      signedBody = init.body
      return jsonResponse({
        result: null,
        error: [`EAPI:Permission denied for ${EARN_KEY} using ${EARN_SECRET}`],
      })
    }

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: { warn: (message: string) => captured.push(message) },
      })

      const error = await captureError(() => client.getStrategies())

      // The request really was fully signed...
      assert.isNotEmpty(signedHeader)
      assert.isNotEmpty(signedBody)

      // ...and none of it leaked into the log or the error surface.
      const surface = `${captured.join('\n')}\n${error?.message ?? ''}`
      assert.notInclude(surface, EARN_KEY)
      assert.notInclude(surface, EARN_SECRET)
      assert.notInclude(surface, signedHeader)
      assert.notInclude(surface, signedBody)
      assert.include(surface, '[redacted]')
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})

test.group('KrakenEarnClient parsing', () => {
  test('parses strategies and allocations from keyed venue maps', async ({ assert }) => {
    const strategiesResponse = {
      result: {
        items: {
          ES1: {
            asset: 'ETH',
            lock_type: 'bonded',
            can_allocate: true,
            auto_compound: 'enabled',
            user_min_allocation: '0.05',
            user_cap: '0',
            apr_estimate: { low: '0.031', high: '0.041' },
            unbonding_seconds: 172800,
          },
        },
      },
      error: [],
    }
    const allocationsResponse = {
      result: {
        allocations: {
          ES1: {
            asset: 'ETH',
            lock_type: 'bonded',
            allocated: '1.25',
            pending: '0',
            unbonding: '0.1',
            total_rewarded: '0.002',
          },
        },
      },
      error: [],
    }
    let call = 0
    ;(globalThis as any).fetch = async () => jsonResponse(call++ === 0 ? strategiesResponse : allocationsResponse)

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })

      const strategies = await client.getStrategies()
      assert.lengthOf(strategies, 1)
      assert.equal(strategies[0].strategyId, 'ES1')
      assert.equal(strategies[0].lockType, 'bonded')
      assert.isTrue(strategies[0].canAllocate)
      assert.closeTo(strategies[0].minAllocationUsd!, 0.05, 1e-9)
      assert.closeTo(strategies[0].apyLow!, 0.031, 1e-9)
      assert.equal(strategies[0].unbondingSeconds, 172800)

      const allocations = await client.getAllocations()
      assert.lengthOf(allocations, 1)
      assert.closeTo(allocations[0].allocatedNative, 1.25, 1e-12)
      assert.closeTo(allocations[0].totalRewardedNative, 0.002, 1e-12)
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })

  test('parses balances into raw venue codes', async ({ assert }) => {
    ;(globalThis as any).fetch = async () => jsonResponse({ result: { XXBT: '1.5', ZUSD: '250.00' }, error: [] })

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })
      const balances = await client.getBalance()
      assert.deepEqual(balances, { XXBT: '1.5', ZUSD: '250.00' })
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })

  test('parses ledger rewards and converts venue seconds to epoch ms', async ({ assert }) => {
    ;(globalThis as any).fetch = async () =>
      jsonResponse({
        result: {
          ledger: {
            L1: { refid: 'L1', time: 1700000000.5, type: 'reward', asset: 'ETH', amount: '0.01', balance: '2.0' },
            L2: { refid: 'L2', time: 1700003600, type: 'staking', subtype: 'bonded', asset: 'ETH', amount: '0.02' },
          },
          count: 2,
        },
        error: [],
      })

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })

      const { entries, count } = await client.getLedgers({ type: 'staking' })
      assert.equal(count, 2)
      assert.lengthOf(entries, 2)
      assert.equal(entries[0].refid, 'L1')
      assert.closeTo(entries[0].time, 1700000000500, 1e-3)
      assert.closeTo(entries[0].amount, 0.01, 1e-12)
      assert.equal(entries[1].subtype, 'bonded')
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})

test.group('KrakenService signedRequest', () => {
  test('signs with supplied credentials and throws on a non-ok HTTP response', async ({ assert }) => {
    let captured: any = null
    ;(globalThis as any).fetch = async (_url: string, init: any) => {
      captured = init
      return { ok: false, status: 503, json: async () => ({ error: [] }) }
    }

    try {
      const service = new KrakenService()
      const error = await captureError(() =>
        service.signedRequest('/0/private/Balance', {}, { key: 'earn-key', secret: EARN_SECRET })
      )

      assert.match(String(error?.message), /Kraken HTTP 503/)
      assert.equal(captured.headers['API-Key'], 'earn-key')
      assert.isNotEmpty(captured.headers['API-Sign'])
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })

  test('vendor error arrays still throw after the refactor', async ({ assert }) => {
    ;(globalThis as any).fetch = async () => jsonResponse({ result: null, error: ['EAPI:Invalid key'] })

    try {
      const service = new KrakenService()
      const error = await captureError(() =>
        service.signedRequest('/0/private/Balance', {}, { key: 'earn-key', secret: EARN_SECRET })
      )
      assert.match(String(error?.message), /EAPI:Invalid key/)
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})

test.group('KrakenEarnClient operation status', () => {
  test('parses status payloads with field aliases', async ({ assert }) => {
    ;(globalThis as any).fetch = async () =>
      jsonResponse({
        result: { refid: 'OP-9', status: 'settled', strategy_id: 'ES1', amount: '2.5' },
        error: [],
      })

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })
      const status = await client.getAllocateStatus('OP-9')
      assert.equal(status.refid, 'OP-9')
      assert.equal(status.status, 'settled')
      assert.equal(status.strategyId, 'ES1')
      assert.closeTo(status.amount!, 2.5, 1e-12)
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })

  test('unknown status values fall back to unknown', async ({ assert }) => {
    ;(globalThis as any).fetch = async () => jsonResponse({ result: {}, error: [] })

    try {
      const client = new KrakenEarnClient({
        key: EARN_KEY,
        secret: EARN_SECRET,
        service: new KrakenService(),
        logger: silentLogger().logger,
      })
      const status = await client.getDeallocateStatus('OP-10')
      assert.equal(status.status, 'unknown')
      assert.isNull(status.amount)
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})
