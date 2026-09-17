import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { BarRecorderService, RETENTION_DAYS } from '../../app/services/BarRecorderService.js'
import { loadBacktestSamples } from '../../app/services/backtest_data.js'
import type { KrakenCandle } from '../../app/services/KrakenDataService.js'

// Bar recorder: closed bars only, conflict-ignore upserts, coverage/health
// signal, 400-day retention, and the bar_records backtest source.

const INTERVAL_MINUTES = 5
const INTERVAL_SECONDS = INTERVAL_MINUTES * 60
const INTERVAL_MS = INTERVAL_SECONDS * 1000

function candle(openTimeMs: number, close = 100): KrakenCandle {
  return {
    time: Math.floor(openTimeMs / 1000),
    open: close,
    high: close + 1,
    low: close - 1,
    close: close + 0.5,
    volume: 3,
  }
}

function providerReturning(candles: KrakenCandle[], calls?: number[]) {
  return {
    getOHLC: async (_symbol: string, _intervalMinutes: number, since?: number) => {
      calls?.push(since ?? -1)
      return { candles, lastTime: candles.length ? candles[candles.length - 1].time : null }
    },
  }
}

async function insertBar(symbol: string, ts: number, intervalSeconds = INTERVAL_SECONDS) {
  await db.table('bar_records').insert({
    symbol,
    interval_seconds: intervalSeconds,
    ts,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
  })
}

function countBars(symbol = 'BTC') {
  return db.from('bar_records').where('symbol', symbol).count('* as total').first().then((r: any) => Number(r.total))
}

test.group('BarRecorderService', (group) => {
  group.each.setup(async () => {
    await db.from('bar_records').delete()
  })

  test('stores only closed bars and re-recording does not duplicate', async ({ assert }) => {
    const base = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
    const now = base + INTERVAL_MS + 1000 // base bar closed, next one in progress

    const service = new BarRecorderService(
      providerReturning([candle(base), candle(base + INTERVAL_MS)]),
      () => now,
      ['BTC']
    )

    assert.equal(await service.recordSymbol('BTC', INTERVAL_MINUTES), 1)
    assert.equal(await countBars(), 1)

    assert.equal(await service.recordSymbol('BTC', INTERVAL_MINUTES), 0)
    assert.equal(await countBars(), 1)
  })

  test('overlapping fetch windows merge without gaps or duplicates', async ({ assert }) => {
    const base = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
    const calls: number[] = []
    const provider = providerReturning(
      [candle(base), candle(base + INTERVAL_MS), candle(base + 2 * INTERVAL_MS), candle(base + 3 * INTERVAL_MS)],
      calls
    )

    // First pass: only the first bar is closed.
    let now = base + INTERVAL_MS + 1000
    let service = new BarRecorderService(provider, () => now, ['BTC'])
    await service.recordSymbol('BTC', INTERVAL_MINUTES)
    assert.equal(await countBars(), 1)

    // Second pass, much later: the provider replays the whole window.
    now = base + 3 * INTERVAL_MS + 1000
    service = new BarRecorderService(provider, () => now, ['BTC'])
    await service.recordSymbol('BTC', INTERVAL_MINUTES)
    assert.equal(await countBars(), 3)

    // The second fetch started from the newest stored bar.
    assert.equal(calls[1], Math.floor(base / 1000))

    const coverage = await service.coverage('BTC', INTERVAL_SECONDS)
    assert.lengthOf(coverage.gaps, 0)
    assert.equal(coverage.bars, 3)
    assert.isTrue(coverage.healthy)
  })

  test('the bar_records source returns ascending bars and honors the interval', async ({ assert }) => {
    const now = Date.now()
    const base = Math.floor((now - 3 * 60 * 60 * 1000) / INTERVAL_MS) * INTERVAL_MS
    await insertBar('BTC', base)
    await insertBar('BTC', base + INTERVAL_MS)
    await insertBar('BTC', base + 2 * INTERVAL_MS)
    // A finer series must not leak into the 5m read.
    await insertBar('BTC', base + 60_000, 60)

    const fiveMinute = await loadBacktestSamples({
      symbol: 'BTC',
      intervalSeconds: 300,
      hours: 24,
      source: 'bar_records',
      broker: 'kraken',
    })
    assert.lengthOf(fiveMinute.samples, 3)
    assert.match(fiveMinute.label, /bar_records/)
    assert.isBelow(fiveMinute.samples[0].t, fiveMinute.samples[1].t)
    assert.isBelow(fiveMinute.samples[1].t, fiveMinute.samples[2].t)
    assert.closeTo(fiveMinute.samples[0].p, 100.5, 1e-9)

    const oneMinute = await loadBacktestSamples({
      symbol: 'BTC',
      intervalSeconds: 60,
      hours: 24,
      source: 'bar_records',
      broker: 'kraken',
    })
    assert.lengthOf(oneMinute.samples, 1)
  })

  test('a fetch failure leaves stored bars untouched and reports unhealthy coverage', async ({ assert }) => {
    const base = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
    await insertBar('BTC', base)

    const failing = {
      getOHLC: async () => {
        throw new Error('kraken down')
      },
    }
    const service = new BarRecorderService(failing, () => base + INTERVAL_MS + 1000, ['BTC'])

    const results = await service.recordAll()
    assert.isFalse(results['BTC:300'].ok)
    assert.equal(await countBars(), 1)

    const coverage = await service.coverage('BTC', INTERVAL_SECONDS)
    assert.isFalse(coverage.healthy)
    assert.equal(coverage.lastError, 'kraken down')
  })

  test('a gap wider than the fetch window is unrecoverable, not smoothed', async ({ assert }) => {
    const base = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
    const gapStart = base - 61 * 60 * 60 * 1000
    await insertBar('BTC', gapStart)
    await insertBar('BTC', base)

    const service = new BarRecorderService(providerReturning([]), () => base + INTERVAL_MS, ['BTC'])
    const coverage = await service.coverage('BTC', INTERVAL_SECONDS)

    assert.lengthOf(coverage.gaps, 1)
    assert.equal(coverage.gaps[0].missingBars, 731)
    assert.isTrue(coverage.gaps[0].unrecoverable)
    assert.equal(coverage.unrecoverableGaps, 1)
    assert.isFalse(coverage.healthy)
  })

  test('pruning never removes bars inside the evaluation window', async ({ assert }) => {
    const now = Date.now()
    const oldTs = Math.floor((now - (RETENTION_DAYS + 1) * 86_400_000) / INTERVAL_MS) * INTERVAL_MS
    const inWindowTs = Math.floor((now - 100 * 86_400_000) / INTERVAL_MS) * INTERVAL_MS
    const recentTs = Math.floor((now - 3_600_000) / INTERVAL_MS) * INTERVAL_MS

    await insertBar('BTC', oldTs)
    await insertBar('BTC', inWindowTs)
    await insertBar('BTC', recentTs)

    const service = new BarRecorderService(providerReturning([]), () => now, ['BTC'])
    const deleted = await service.prune()

    assert.equal(deleted, 1)
    const remaining = await db.from('bar_records').where('symbol', 'BTC').orderBy('ts', 'asc').select('ts')
    assert.deepEqual(
      remaining.map((row: any) => Number(row.ts)),
      [inWindowTs, recentTs]
    )
  })
})
