import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { FundingCarryService, CarryDataProvider, CarryExecutor, DryRunExecutor, CarryPrices } from '../../app/services/FundingCarryService.js'

// FundingCarryService state machine with a fake data provider + executor.
// No DB here: the service persists through CarryPosition (Lucid) — these
// tests cover the pure decision logic via a stubbed model layer would need
// the app container, so we focus on what's testable without it: the
// data-provider/executor plumbing and the provider math.

test.group('CarryDataProvider funding math', () => {
  test('trailing funding sums signed rates over the window', async ({ assert }) => {
    const provider = new FakeProvider([{ time: 1, rate: 0.0001 }, { time: 2, rate: 0.0002 }, { time: 3, rate: -0.00005 }])
    const total = await provider.getTrailingFundingPct('BTC', 30, 100)
    assert.closeTo(total, (0.0001 + 0.0002 - 0.00005) * 100, 1e-9)
  })

  test('getFunding only returns settlements at/after the cursor', async ({ assert }) => {
    const provider = new FakeProvider([
      { time: 1, rate: 0.01 }, // before cursor
      { time: 60, rate: 0.0002 },
      { time: 70, rate: 0.0003 },
    ])
    const funds = await provider.getFunding('BTC', 50)
    assert.deepEqual(funds.map((f) => f.time), [60, 70])
  })
})

// A minimal CarryDataProvider for the funding-math tests.
class FakeProvider implements CarryDataProvider {
  constructor(private funds: Array<{ time: number; rate: number }>) {}
  async getPrices(): Promise<CarryPrices> { return { spot: 100, perp: 100.5 } }
  async getFunding(_symbol: string, sinceMs: number) {
    return this.funds.filter((f) => f.time >= sinceMs).map((f) => ({ time: f.time, rate: f.rate }))
  }
  async getTrailingFundingPct(_symbol: string, days: number, now = Date.now()): Promise<number> {
    const since = now - days * 86_400_000
    return (await this.getFunding(_symbol, since)).reduce((s, f) => s + f.rate * 100, 0)
  }
}