# ALGO PRODUCT — Daily-Trend Composite (frozen candidate 2026-09-07)

The most-verified money-maker the syphon algo investigation produced. Freeze
status: **config frozen for evaluation, NOT deployed** — and as of 2026-09-07
a follow-up found the freeze numbers are cadence-dependent. The freeze
evidence below came from 5m-close-only decisions; on the finer 1m cadence
(closer to live execution reality) the product fails its own risk contract
(2025 composite −29%, ETH −20-26% over 3y). Trail-confirmation (30-240s)
recovers part of the gap but not enough. **Deployment blocked until the
cadence question is resolved or the product is re-certified on the chosen
execution granularity.** The investigation history and rejected alternatives
live in `ALGO_WIP.md`.

## What it is

Daily-horizon trend riding on BTC/ETH/SOL, long-only, equal-weight basket,
one position per asset, holding days-to-weeks. Trend mode (price > EMA-1d,
EMA slope ≥ 1.5%/3d), a slow regime gate (4d EMA rising ≥ 1.5%/7d), and the
Kaufman efficiency-ratio gate (14d ER ≥ 40%) that blocks chop-regime
whipsaw entries. Stops: −5% hard SL; trailing stop 12% behind peak once +6%
profit; no take-profit (winners ride).

## Frozen configuration

Strategy (FastStrategyConfig, `sampleIntervalSeconds = 300`, i.e. 5m bars):

| field | value | meaning |
|---|---|---|
| trendMode | true | entry = trend-confirmed |
| emaPeriod | 288 | EMA over 1 day (5m bars) |
| trendSlopePct / trendSlopeWindowSeconds | 1.5 / 259200 | EMA rising ≥1.5% over 3 days |
| regimeEmaPeriod | 1152 | 4-day EMA regime filter |
| regimeSlopeWindowSeconds / regimeSlopeMinPct | 604800 / 1.5 | regime EMA rising ≥1.5% over 7 days |
| efficiencyWindowDays / efficiencyMinPct | 14 / 40 | Kaufman ER ≥ 40 over 14 days |
| stopLossPct | 5 | hard stop |
| trailingStopPct / trailingActivatePct | 12 / 6 | trail arms at +6% |
| takeProfitPct / exitReversalPct | 0 / −99 | off — ride the trail |
| efficiencyExitPct | 0 | exit-side ER cut REJECTED (data, see below) |
| all other controls | 0/off | |

Engine: loop 300s, market fills, taker fee 0.26%/side, slippage 10bps,
portfolio $10k per asset, maxPositions 1, maxExposure 0.9, maxSinglePosition
0.9, cooldown 0. (Maker entry = savings ~0.1pp/side when deployed.)

## Evidence (in-sample freeze set: 2023-09 → 2026-09)

Equal-weight composite of monthly returns, ER14d/40 entry gate:

| year | strategy | buy&hold | green months |
|---|---|---|---|
| 2024 | **+21.0%** | +88.6% | 6/12 |
| 2025 | **+4.3%** | −0.9% | 3/12 |
| 2026(p) | **+10.1%** | −4.4% | 2/9 |
| full | ~+36%/3y | — | — |

Per asset (full 3y, ER14d/40): BTC +86.8% (19t, PF 1.92), ETH +76.8% (27t, PF
1.66), SOL +77.3% (44t, PF 1.49) — all three positive, none dependent on one
asset. Every calendar year positive; the 2025 chop year — which killed every
pre-ER config (−14.8%) — is the differentiator.

## Risk contract — what you are actually buying

REALITY (three years, three assets):
- Average drift ~+1.0-1.3%/month. NOT a smooth 1-3% every month.
- ~1/3 of months are green; returns are lumpy: a few +5-30% months carry
  the year, most months are flat-to-slightly-down.
- Occasional single months of −5 to −12% are normal.
- It lags buy&hold in strong bull years (+21% vs +89% in 2024) — it is a
  *chop-avoiding trend timer*, not an alpha machine over holding.
- Track record = 3 years, one structural regime mix, partially in-sample
  (2026 was in the selection loop). t-stats ~1.0-1.4 = suggestive, not
  statistically proven.

CONTRACT (evaluation phase — what we hold it to before any capital):
1. Paper-trade the frozen config live (daily decisions on 5m bars) for ≥ 6
   months or ≥ 2 consecutive positive-then-negative regime transitions.
2. Tripwires that stop the line: two consecutive negative months, or > 15%
   drawdown from peak equity during evaluation → halt and re-open the
   investigation.
3. Do NOT tune on the first bad month — lumpiness is part of the product.
4. Re-verify against the growing 1s/1m caches quarterly.

NON-GOALS (explicitly rejected by 3y multi-asset evidence):
- Intraday/intra-week 1-3% returns (fee wall; every sub-4h config lost).
- Monthly consistency ≥ 40% green months (structurally impossible for
  trend following — 45+ configs tested).
- Short side (not implemented; would only help bear years, not the chop
  year that mattered).

## Reproduce

Evaluation scripts (configs, monthly/year slice stats, gate):
`/tmp/ltsweep/*.ts` (gate3 = ER grid, anatomy = 2025 trade forensics) — to be
promoted into a repo command (`backtest:longterm` + a frozen-config runner)
before deployment. Data: `backend/backtests/cache/{BTC,ETH,SOL}_1m_1095d.json`.

## Open items before deployment

1. Promote the frozen-config eval into a repeatable ace command.
2. Deployment vehicle does not exist: needs a slow (5m-bar) decision loop
   over Kraken OHLC — the FastAlgoService 1s intraday loop cannot hold a
   daily EMA (feed caps at 4h of 1s samples).
3. Decide evaluation venue (Kraken spot long-only, 3 assets).
