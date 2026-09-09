import { test } from '@japa/runner'
import { EventDedupService, eventProbe, tokensJaccard } from '../../app/services/EventDedupService.js'

// Event clustering: the same story from different channels must collapse
// into one cluster (one vote in the news score) while unrelated stories
// stay apart. Pure fingerprint + fake-redis integration.

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async set(key: string, value: string) { store.set(key, value); return 'OK' },
    async expire(_key: string, _seconds: number) { return 1 },
  }
}

test.group('eventProbe', () => {
  test('identical titles produce identical probes', ({ assert }) => {
    const a = eventProbe('Bitcoin drops 5% as exchange reports hack')
    const b = eventProbe('Bitcoin drops 5% as exchange reports hack')
    assert.isNotNull(a)
    assert.isNotNull(b)
    assert.equal(a!.probe, b!.probe)
    assert.deepEqual(a!.tokens, b!.tokens)
  })

  test('near-identical titles share most tokens', ({ assert }) => {
    const a = eventProbe('Bitcoin drops 5% as exchange reports hack')
    const b = eventProbe('Exchange reports hack as bitcoin drops 5%')
    assert.isNotNull(a)
    assert.isNotNull(b)
    assert.isAbove(tokensJaccard(a!.tokens, b!.tokens), 0.6)
  })

  test('unrelated titles have low token overlap', ({ assert }) => {
    const a = eventProbe('Bitcoin drops 5% as exchange reports hack')
    const b = eventProbe('Ethereum staking yields rise after Shanghai upgrade')
    assert.isNotNull(a)
    assert.isNotNull(b)
    assert.isBelow(tokensJaccard(a!.tokens, b!.tokens), 0.4)
  })

  test('generic short titles do not cluster', ({ assert }) => {
    assert.isNull(eventProbe('Bitcoin price today'))
    assert.isNull(eventProbe(''))
  })

  test('prices and stopwords do not pollute tokens', ({ assert }) => {
    const a = eventProbe('Bitcoin drops 5% as the exchange reports a hack')
    assert.isNotNull(a)
    assert.isFalse(a!.tokens.includes('the'))
    assert.isFalse(a!.tokens.includes('5'))
    assert.isFalse(a!.tokens.includes('a'))
  })
})

test.group('EventDedupService', () => {
  test('first article opens a cluster with its own id', async ({ assert }) => {
    const service = new EventDedupService(fakeRedis() as any)
    const key = await service.getOrCreateEvent('Bitcoin drops 5% as exchange reports hack', 101)
    assert.equal(key, '101')
  })

  test('similar title joins the existing cluster', async ({ assert }) => {
    const redis = fakeRedis()
    const service = new EventDedupService(redis as any)
    const first = await service.getOrCreateEvent('Bitcoin drops 5% as exchange reports hack', 101)
    const second = await service.getOrCreateEvent('Exchange reports hack as bitcoin drops 5%', 202)
    assert.equal(second, first)
    assert.equal(second, '101')
  })

  test('unrelated title with colliding probe opens a new cluster', async ({ assert }) => {
    const redis = fakeRedis()
    const service = new EventDedupService(redis as any)
    const first = await service.getOrCreateEvent('Bitcoin drops 5% as exchange reports hack', 101)
    const second = await service.getOrCreateEvent('Bitcoin drops trading pair on regulated exchange', 202)
    assert.notEqual(second, first)
  })

  test('redis failure fails open to null', async ({ assert }) => {
    const broken = {
      async get() { throw new Error('connection refused') },
      async set() { throw new Error('connection refused') },
      async expire() { throw new Error('connection refused') },
    }
    const service = new EventDedupService(broken as any)
    const key = await service.getOrCreateEvent('Bitcoin drops 5% as exchange reports hack', 101)
    assert.isNull(key)
  })
})