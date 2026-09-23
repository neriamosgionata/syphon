import { test } from '@japa/runner'
import {
  JevDecisionService,
  JEV_MODEL_ID,
  JEV_TIMEOUT_MS,
  JEV_MAX_INPUT_CHARS,
  JEV_MIN_CONFIDENCE,
  type JevRawResult,
  type JevSymbolState,
  type JevTransport,
} from '../../app/services/JevDecisionService.js'

// Jev sidecar client (U1): version-pinned, injectable transport, bounded
// latency, fail-open null context. Every test runs on stubbed transports —
// no network, no key. A single live check is sketched as a skipped test.

const TEST_KEY = 'sk-jev-test-key-9f8e7d6c5b4a'

function successPayload(overrides: Record<string, any> = {}): JevRawResult {
  return {
    model: JEV_MODEL_ID,
    answers: {
      direction: {
        type: 'choice',
        choice: 'up',
        confidence: 0.8,
        probabilities: { up: 0.7, down: 0.2, flat: 0.1 },
      },
      strength: {
        type: 'score',
        score: 3,
        confidence: 0.75,
        legend: { 0: 'none', 1: 'weak', 2: 'firm', 3: 'strong' },
        probabilities: { 0: 0.05, 1: 0.1, 2: 0.25, 3: 0.6 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  }
}

function stubTransport(opts: {
  result?: JevRawResult
  error?: any
  failTimes?: number
  onCall?: (body: any) => void
} = {}): JevTransport & { calls: number; bodies: any[]; failTimes?: number; error?: any } {
  const stub = {
    calls: 0,
    bodies: [] as any[],
    failTimes: opts.failTimes,
    error: opts.error,
    async score(body: any) {
      stub.calls++
      stub.bodies.push(body)
      if (opts.onCall) opts.onCall(body)
      if (stub.failTimes && stub.calls <= stub.failTimes) throw stub.error ?? new Error('boom')
      if (stub.error && !stub.failTimes) throw stub.error
      return opts.result ?? successPayload()
    },
  }
  return stub
}

function state(overrides: Partial<JevSymbolState> = {}): JevSymbolState {
  return {
    symbol: 'BTC',
    facts: { momentumPct: 0.12, rsi: 55, emaSlopePct: 0.03, volatilityPct: 0.4, priceChangePct: 0.1 },
    headlines: ['ETF inflows hit record', 'Exchange lists new pair'],
    asOf: 1_700_000_000_000,
    ...overrides,
  }
}

function silentLogger() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
  }
}

function statusError(status: number, extra: Record<string, any> = {}): any {
  const err: any = new Error(`Jev HTTP ${status}`)
  err.status = status
  err.headers = extra.headers ?? {}
  if (extra.retryAfterMs !== undefined) err.retryAfterMs = extra.retryAfterMs
  return err
}

test.group('JevDecisionService happy path', () => {
  test('returns populated context with provenance and usage', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    const ctx = await svc.getDecision(state())

    assert.isNotNull(ctx)
    assert.equal(ctx!.symbol, 'BTC')
    assert.closeTo(ctx!.pUp, 0.7, 1e-12)
    assert.closeTo(ctx!.pDown, 0.2, 1e-12)
    assert.closeTo(ctx!.confidence, 0.75, 1e-12)
    assert.equal(ctx!.model, JEV_MODEL_ID)
    assert.deepEqual(ctx!.usage, { inputTokens: 100, outputTokens: 20 })
    assert.isFalse(ctx!.stale)
    assert.isNull(svc.getLastFailure())
    const prov = svc.getProvenance()
    assert.isNotNull(prov)
    assert.equal(prov!.model, JEV_MODEL_ID)
    assert.deepEqual(prov!.usage, { inputTokens: 100, outputTokens: 20 })
  })

  test('logs model provenance and token usage per call', async ({ assert }) => {
    const { lines, logger } = silentLogger()
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport: stubTransport(), logger })
    await svc.getDecision(state())
    const joined = lines.join('\n')
    assert.include(joined, JEV_MODEL_ID)
    assert.include(joined, '100')
    assert.include(joined, '20')
  })

  test('batches all questions for the symbol into one call', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    await svc.getDecision(state())
    assert.equal(transport.calls, 1)
    const body = transport.bodies[0]
    assert.properties(body.questions, ['direction', 'strength'])
  })

  test('uses the pinned model id, never the jev-latest alias', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    await svc.getDecision(state())
    assert.equal(transport.bodies[0].model, JEV_MODEL_ID)
    assert.notEqual(transport.bodies[0].model, 'jev-latest')
  })

  test('per-call timeout default is near 2s', ({ assert }) => {
    assert.isTrue(JEV_TIMEOUT_MS >= 1500 && JEV_TIMEOUT_MS <= 3000)
  })
})

test.group('JevDecisionService failure classes degrade to null', () => {
  test('timeout resolves to null with class recorded, no throw', async ({ assert }) => {
    const hanging: JevTransport = { async score() { return new Promise(() => {}) } }
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport: hanging,
      timeoutMs: 20,
      logger: silentLogger().logger,
    })
    const started = Date.now()
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.isTrue(Date.now() - started < 2000)
    assert.equal(svc.getLastFailure()?.class, 'timeout')
  })

  test('transport error retries at most once, then null', async ({ assert }) => {
    const transport = stubTransport({ error: new TypeError('fetch failed'), failTimes: 99 })
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(transport.calls, 2)
    assert.equal(svc.getLastFailure()?.class, 'transport')
  })

  test('transport recovers on the retry', async ({ assert }) => {
    const transport = stubTransport({ error: new TypeError('fetch failed'), failTimes: 1 })
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    const ctx = await svc.getDecision(state())
    assert.isNotNull(ctx)
    assert.equal(transport.calls, 2)
  })

  test('429 degrades to null with backoff honored and no tick-blocking wait', async ({ assert }) => {
    const transport = stubTransport({ error: statusError(429, { headers: { 'retry-after': '60' } }) })
    let now = 1_700_000_000_000
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      now: () => now,
      logger: silentLogger().logger,
    })
    const first = await svc.getDecision(state())
    assert.isNull(first)
    assert.equal(svc.getLastFailure()?.class, 'rate_limited')
    assert.equal(transport.calls, 1)

    now += 10_000
    const started = Date.now()
    const second = await svc.getDecision(state())
    assert.isNull(second)
    assert.equal(transport.calls, 1)
    assert.isTrue(Date.now() - started < 1000)
  })

  test('529 degrades to null like 429, no retry', async ({ assert }) => {
    const transport = stubTransport({ error: statusError(529) })
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(transport.calls, 1)
    assert.equal(svc.getLastFailure()?.class, 'rate_limited')
  })

  test('422 degrades to null without retry', async ({ assert }) => {
    const transport = stubTransport({ error: statusError(422) })
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(transport.calls, 1)
    assert.equal(svc.getLastFailure()?.class, 'validation')
  })

  test('low confidence degrades to null', async ({ assert }) => {
    const weak = successPayload({
      answers: {
        direction: { type: 'choice', choice: 'up', confidence: 0.1, probabilities: { up: 0.4, down: 0.3, flat: 0.3 } },
        strength: { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: {} },
      },
    })
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport: stubTransport({ result: weak }),
      minConfidence: JEV_MIN_CONFIDENCE,
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(svc.getLastFailure()?.class, 'low_confidence')
  })
})

test.group('JevDecisionService staleness', () => {
  test('reuses fresh cache on failure, then null when stale', async ({ assert }) => {
    const transport = stubTransport()
    let now = 1_700_000_000_000
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      now: () => now,
      logger: silentLogger().logger,
    })
    const fresh = await svc.getDecision(state())
    assert.isNotNull(fresh)

    transport.failTimes = 99
    transport.error = new TypeError('fetch failed')
    now += 60_000
    const reused = await svc.getDecision(state())
    assert.isNotNull(reused)
    assert.isTrue(reused!.stale)
    assert.closeTo(reused!.pUp, 0.7, 1e-12)

    now += 60_000
    const gone = await svc.getDecision(state())
    assert.isNull(gone)
    assert.equal(svc.getLastFailure()?.class, 'stale')
  })
})

test.group('JevDecisionService auth', () => {
  test('revoked credentials alert immediately with no retry and latch deterministic-only', async ({ assert }) => {
    const transport = stubTransport({ error: statusError(401) })
    const alerts: any[] = []
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      onAlert: (a) => alerts.push(a),
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(transport.calls, 1)
    assert.equal(svc.getLastFailure()?.class, 'auth')
    assert.lengthOf(alerts, 1)
    assert.equal(alerts[0].kind, 'auth')

    const second = await svc.getDecision(state())
    assert.isNull(second)
    assert.equal(transport.calls, 1)
    assert.isTrue(svc.isDeterministicOnly())
  })
})

test.group('JevDecisionService fixtures and offline use', () => {
  test('serves recorded fixtures when unkeyed without touching the network', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({
      apiKey: '',
      transport,
      fixtures: { BTC: { pUp: 0.62, pDown: 0.3, confidence: 0.7 } },
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNotNull(ctx)
    assert.closeTo(ctx!.pUp, 0.62, 1e-12)
    assert.isTrue(ctx!.fixture)
    assert.include(ctx!.model, 'fixture')
    assert.equal(transport.calls, 0)
  })

  test('keyed calls ignore fixtures and use the live path', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      fixtures: { BTC: { pUp: 0.62, pDown: 0.3, confidence: 0.7 } },
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNotNull(ctx)
    assert.closeTo(ctx!.pUp, 0.7, 1e-12)
    assert.equal(transport.calls, 1)
  })

  test('unkeyed without a fixture degrades to null', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: '', transport, logger: silentLogger().logger })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(svc.getLastFailure()?.class, 'unkeyed')
    assert.equal(transport.calls, 0)
  })

  test('constructs offline without throwing', ({ assert }) => {
    assert.doesNotThrow(() => new JevDecisionService({ apiKey: '' }))
    assert.doesNotThrow(() => new JevDecisionService())
  })
})

test.group('JevDecisionService redaction', () => {
  test('no credential material in failure state or logs', async ({ assert }) => {
    const { lines, logger } = silentLogger()
    const transport = stubTransport({ error: new Error(`upstream exploded on ${TEST_KEY} bearer`) })
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    const failure = svc.getLastFailure()!
    assert.notInclude(failure.message, TEST_KEY)
    const joined = lines.join('\n')
    assert.notInclude(joined, TEST_KEY)
  })
})

test.group('JevDecisionService SDK seam and shape drift', () => {
  test('SDK shape drift falls over to raw-HTTPS fallback with alert', async ({ assert }) => {
    const sdk = { async systemOne() { return { model: JEV_MODEL_ID, answers: {}, usage: {} } } }
    const fetchCalls: any[] = []
    const fakeFetch = (async (_url: string, init: any) => {
      fetchCalls.push(init)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => successPayload(),
      }
    }) as any
    const alerts: any[] = []
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      sdk,
      fetch: fakeFetch,
      onAlert: (a) => alerts.push(a),
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNotNull(ctx)
    assert.closeTo(ctx!.pUp, 0.7, 1e-12)
    assert.equal(fetchCalls.length, 1)
    assert.isTrue(alerts.some((a) => a.kind === 'shape_drift'))
  })

  test('responding model that moved off the pin is never silently followed', async ({ assert }) => {
    const moved = successPayload({ model: 'jev-latest' })
    const alerts: any[] = []
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport: stubTransport({ result: moved }),
      onAlert: (a) => alerts.push(a),
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(svc.getLastFailure()?.class, 'shape_drift')
    assert.isTrue(alerts.some((a) => a.kind === 'shape_drift'))
  })

  test('malformed probabilities degrade to null with drift recorded', async ({ assert }) => {
    const bad = successPayload({
      answers: {
        direction: { type: 'choice', choice: 'up', confidence: 0.9, probabilities: { up: NaN, down: 'x', flat: 0.1 } },
        strength: { type: 'score', score: 2, confidence: 0.8, legend: {}, probabilities: {} },
      },
    })
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport: stubTransport({ result: bad }),
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNull(ctx)
    assert.equal(svc.getLastFailure()?.class, 'shape_drift')
  })
})

test.group('JevDecisionService payload allowlist and shaping', () => {
  test('request body carries only allowlisted keys', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    await svc.getDecision(
      state({ facts: { momentumPct: 0.1, rsi: 50, accountId: 'ACCT-1' } as any })
    )
    const body = transport.bodies[0]
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state'])
    assert.deepEqual(Object.keys(body.state).sort(), ['headlines', 'indicators', 'symbol'])
    const serialized = JSON.stringify(body)
    for (const forbidden of [
      'accountId',
      'account_id',
      'balance',
      'position',
      'orderId',
      'order_id',
      'clientOrderId',
      'cl_ord_id',
      'quantity',
      'apiKey',
      'secret',
      'ACCT-1',
    ]) {
      assert.notInclude(serialized, forbidden)
    }
    assert.isTrue(body.state.indicators.momentumPct === 0.1)
    assert.isFalse('accountId' in body.state.indicators)
  })

  test('headlines are stripped, deduped, and capped', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    await svc.getDecision(
      state({
        headlines: [
          'See https://example.com/x <b>ETF</b> approval rally',
          'ETF approval rally',
          '   ',
          ...Array.from({ length: 30 }, (_, i) => `filler headline number ${i} with extra words`),
        ],
      })
    )
    const headlines: string[] = transport.bodies[0].state.headlines
    assert.isTrue(headlines.length <= 10)
    assert.isTrue(headlines.every((h) => !h.includes('http') && !h.includes('<')))
    assert.equal(new Set(headlines.map((h) => h.toLowerCase())).size, headlines.length)
  })

  test('per-call input-size cap truncates with facts intact', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      // Fixed question/indicator overhead alone is ~560 chars, so the cap
      // must clear that floor for any headline to survive truncation.
      maxInputChars: 800,
      logger: silentLogger().logger,
    })
    await svc.getDecision(
      state({ headlines: Array.from({ length: 20 }, (_, i) => `headline ${i} `.padEnd(100, 'x')) })
    )
    const serialized = JSON.stringify(transport.bodies[0])
    assert.isTrue(serialized.length <= 800)
    assert.equal(transport.bodies[0].state.symbol, 'BTC')
    assert.isTrue(transport.bodies[0].state.indicators.momentumPct === 0.12)
    assert.isTrue(transport.bodies[0].state.headlines.length > 0)
  })

  test('default input cap is bounded', ({ assert }) => {
    assert.isTrue(JEV_MAX_INPUT_CHARS > 0 && JEV_MAX_INPUT_CHARS <= 32000)
  })
})

test.group('JevDecisionService budgets', () => {
  test('per-day call budget auto-downgrades to deterministic-only', async ({ assert }) => {
    const transport = stubTransport()
    const alerts: any[] = []
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      maxCallsPerDay: 1,
      onAlert: (a) => alerts.push(a),
      logger: silentLogger().logger,
    })
    const first = await svc.getDecision(state())
    assert.isNotNull(first)
    const second = await svc.getDecision(state())
    assert.isNull(second)
    assert.equal(svc.getLastFailure()?.class, 'budget')
    assert.equal(transport.calls, 1)
    assert.isTrue(svc.isDeterministicOnly())
    assert.isTrue(alerts.some((a) => a.kind === 'budget'))
  })

  test('spend budget trips on token usage', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      maxSpendUsdPerDay: 0.000001,
      logger: silentLogger().logger,
    })
    const first = await svc.getDecision(state())
    assert.isNotNull(first)
    const second = await svc.getDecision(state())
    assert.isNull(second)
    assert.equal(svc.getLastFailure()?.class, 'budget')
  })
})

test.group('JevDecisionService auth latch vs key rotation', () => {
  test('same-day key rotation clears the auth latch and resumes scoring', async ({ assert }) => {
    const ROTATED_KEY = 'sk-jev-rotated-key-1a2b3c4d5e6f'
    const transport = stubTransport({ error: statusError(401), failTimes: 1 })
    let now = 1_700_000_000_000
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      now: () => now,
      logger: silentLogger().logger,
    })
    const first = await svc.getDecision(state())
    assert.isNull(first)
    assert.equal(svc.getLastFailure()?.class, 'auth')
    assert.isTrue(svc.isDeterministicOnly())

    const latch = (svc as any).latch
    assert.isNotNull(latch)
    assert.equal(latch.kind, 'auth')
    assert.match(latch.keyFingerprint, /^[0-9a-f]{8}$/)
    assert.notInclude(latch.keyFingerprint, TEST_KEY)

    // Same-day rotation (mutated opt stands in for a rotated env credential —
    // the new key has never failed, so the proving call must proceed).
    ;(svc as any).opts.apiKey = ROTATED_KEY
    now += 60_000
    const second = await svc.getDecision(state())
    assert.isNotNull(second)
    assert.closeTo(second!.pUp, 0.7, 1e-12)
    assert.isFalse(svc.isDeterministicOnly())
    assert.equal(transport.calls, 2)
  })

  test('key fingerprints distinguish keys without leaking key material', async ({ assert }) => {
    async function latchedFingerprint(key: string): Promise<string> {
      const svc = new JevDecisionService({
        apiKey: key,
        transport: stubTransport({ error: statusError(401) }),
        logger: silentLogger().logger,
      })
      await svc.getDecision(state())
      return (svc as any).latch.keyFingerprint
    }
    const fpA1 = await latchedFingerprint(TEST_KEY)
    const fpA2 = await latchedFingerprint(TEST_KEY)
    const fpB = await latchedFingerprint('sk-jev-other-key-0f9e8d7c6b5a')
    assert.equal(fpA1, fpA2)
    assert.notEqual(fpA1, fpB)
    for (const fp of [fpA1, fpB]) {
      assert.match(fp, /^[0-9a-f]{8}$/)
    }
    assert.notInclude(fpA1, TEST_KEY)
  })

  test('passing preflight clears the auth latch', async ({ assert }) => {
    const transport = stubTransport({ error: statusError(401), failTimes: 1 })
    const svc = new JevDecisionService({ apiKey: TEST_KEY, transport, logger: silentLogger().logger })
    const first = await svc.getDecision(state())
    assert.isNull(first)
    assert.isTrue(svc.isDeterministicOnly())
    const result = await svc.preflight()
    assert.isTrue(result.ok)
    assert.isFalse(svc.isDeterministicOnly())
  })
})

test.group('JevDecisionService raw transport abort', () => {
  test('tick-deadline cancellation reaches the HTTP call', async ({ assert }) => {
    const seen: any[] = []
    const fakeFetch = (async (_url: string, init: any) => {
      seen.push(init)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => successPayload(),
      }
    }) as any
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      sdk: null,
      fetch: fakeFetch,
      logger: silentLogger().logger,
    })
    const ctx = await svc.getDecision(state())
    assert.isNotNull(ctx)
    assert.equal(seen.length, 1)
    assert.instanceOf(seen[0].signal, AbortSignal)
  })

  test('raw transport forwards the caller signal unchanged', async ({ assert }) => {
    const seen: any[] = []
    const fakeFetch = (async (_url: string, init: any) => {
      seen.push(init)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => successPayload(),
      }
    }) as any
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      sdk: null,
      fetch: fakeFetch,
      logger: silentLogger().logger,
    })
    const controller = new AbortController()
    controller.abort()
    const raw = (svc as any).rawTransport(TEST_KEY)
    const result = await raw.score(svc.buildRequestBody(state()), { signal: controller.signal })
    assert.equal(result.model, JEV_MODEL_ID)
    assert.equal(seen.length, 1)
    assert.strictEqual(seen[0].signal, controller.signal)
  })
})

test.group('JevDecisionService preflight and ops safety', () => {
  test('preflight passes keyed and gates live readiness with TTL', async ({ assert }) => {
    const transport = stubTransport()
    let now = 1_700_000_000_000
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport,
      now: () => now,
      logger: silentLogger().logger,
    })
    assert.isFalse(svc.isLiveReady())
    const result = await svc.preflight()
    assert.isTrue(result.ok)
    assert.equal(result.model, JEV_MODEL_ID)
    assert.isTrue(svc.isLiveReady())
    now += 2 * 3600_000
    assert.isFalse(svc.isLiveReady())
  })

  test('preflight fails unkeyed without network', async ({ assert }) => {
    const transport = stubTransport()
    const svc = new JevDecisionService({ apiKey: '', transport, logger: silentLogger().logger })
    const result = await svc.preflight()
    assert.isFalse(result.ok)
    assert.equal(result.failure?.class, 'unkeyed')
    assert.equal(transport.calls, 0)
  })

  test('throwing logger and alert handlers never break the tick', async ({ assert }) => {    const bombing = () => { throw new Error('logger down') }
    const svc = new JevDecisionService({
      apiKey: TEST_KEY,
      transport: stubTransport(),
      logger: { info: bombing, warn: bombing, error: bombing },
      onAlert: () => { throw new Error('alert down') },
    })
    const ctx = await svc.getDecision(state())
    assert.isNotNull(ctx)
  })
})
