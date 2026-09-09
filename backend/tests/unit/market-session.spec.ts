import { test } from '@japa/runner'
import { isEquitySessionOpen, isSessionOpen, US_EQUITY_HOLIDAYS_2026 } from '../../app/services/MarketSession.js'

// Pure session-gate math. All times are constructed in America/New_York
// and converted to epoch ms — the module re-derives ET from the instant.

function etToEpoch(isoEt: string): number {
  return Date.parse(`${isoEt}-04:00`) // EDT
}
function etToEpochEst(isoEt: string): number {
  return Date.parse(`${isoEt}-05:00`) // EST
}

test.group('isEquitySessionOpen', () => {
  test('open during a normal weekday session', ({ assert }) => {
    const at = etToEpoch('2026-09-09T10:00:00')
    assert.deepEqual(isEquitySessionOpen(at), { open: true, reason: 'open' })
  })

  test('closed before the 09:30 open', ({ assert }) => {
    const at = etToEpoch('2026-09-09T09:15:00')
    assert.equal(isEquitySessionOpen(at).open, false)
  })

  test('closed after the 16:00 close', ({ assert }) => {
    const at = etToEpoch('2026-09-09T16:30:00')
    assert.equal(isEquitySessionOpen(at).open, false)
  })

  test('closed on weekends', ({ assert }) => {
    const sat = etToEpoch('2026-09-12T10:00:00')
    const sun = etToEpoch('2026-09-13T10:00:00')
    assert.deepEqual(isEquitySessionOpen(sat), { open: false, reason: 'weekend' })
    assert.deepEqual(isEquitySessionOpen(sun), { open: false, reason: 'weekend' })
  })

  test('closed on market holidays', ({ assert }) => {
    const laborDay = etToEpoch('2026-09-07T10:00:00')
    assert.deepEqual(isEquitySessionOpen(laborDay), { open: false, reason: 'holiday' })
    const christmas = etToEpochEst('2026-12-25T10:00:00')
    assert.equal(isEquitySessionOpen(christmas).open, false)
  })

  test('holiday list covers the 2026 calendar', ({ assert }) => {
    assert.equal(US_EQUITY_HOLIDAYS_2026.length, 10)
  })

  test('half-day closes at 13:00 ET', ({ assert }) => {
    // Plain Friday, not a holiday — isolates the half-day close logic.
    const before = etToEpoch('2026-10-09T11:00:00')
    const after = etToEpoch('2026-10-09T13:30:00')
    assert.equal(isEquitySessionOpen(before, { halfDay: true }).open, true)
    assert.equal(isEquitySessionOpen(after, { halfDay: true }).open, false)
  })
})

test.group('isSessionOpen (venue-agnostic)', () => {
  test('crypto is always open', ({ assert }) => {
    assert.equal(isSessionOpen(etToEpoch('2026-09-12T03:00:00'), 'crypto').open, true)
  })

  test('listed instruments use the equity session', ({ assert }) => {
    assert.equal(isSessionOpen(etToEpoch('2026-09-09T10:00:00'), 'stock').open, true)
    assert.equal(isSessionOpen(etToEpoch('2026-09-09T03:00:00'), 'etf').open, false)
  })

  test('unknown secType fails open', ({ assert }) => {
    assert.equal(isSessionOpen(etToEpoch('2026-09-09T03:00:00'), null).open, true)
    assert.equal(isSessionOpen(etToEpoch('2026-09-09T03:00:00'), undefined).open, true)
  })
})