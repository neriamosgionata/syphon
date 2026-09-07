# ALGO WIP — handoff (2026-08-21)

Where the algo work stands. Maker-execution + volatility-targeting shipped (migration 18, committed). Month-long validation DONE: the edge is regime-lucky, not validated. Toolchain moved to Bun (see AGENTS.md "Bun runtime" section).

## Multi-year 1m certification — THE VERDICT (2026-09-07): strategy loses money

Built the coarse-bar pipeline and answered the certification question on 3 years of data. **The live config loses ~15-18%/yr net of realistic execution. It does not generate value.**

- **`bun ace backtest:longterm --symbol=BTC --days=1095 --window-days=30`** (new command): crawls multi-year Binance 1m klines (checkpointed, `backtests/cache/{SYM}_1m_{days}d.json`; 3y = 1.58M bars ≈ 15 min first fetch), runs the LIVE config (no IS selection) over the full span + consecutive 30d windows.
- **Full span (2023-09 → 2026-09): −45.6% net, 1171 trades, WR 21.3%, PF 0.34, maxDD 45.9%** vs buy&hold +206%. Maker variant (best case): −37.9%, PF 0.38. **1/37 windows net-positive; 0/37 beat buy&hold.** The only positive window is the trending-rally month — same regime-luck as the 1s data. Post-vacation window (Aug 23–Sep 7): −0.38% (9t).
- Matches the 21d 1s month verdict (PF 0.79): the intraminute trend-rider does not pay for its ~78% losers across regimes at 0.26% fees + 10bps slip. The 1s toolchain was right to stay skeptical; 3y of 1m data confirms it. This was ALGO_WIP's open question since 2026-08-21 — now closed: **the edge does not exist at this horizon**. Do NOT deploy as-is.
- Toolchain changes: `BacktestEngine`/`FastStrategy`/`MomentumFeed` are now interval-aware (`sampleIntervalSeconds`, default 1 = zero change; 60 = 1m bars: sample-count lookbacks ÷60, time windows untouched, per-minute vol + vol-target annualization cadence-corrected, engine decides once per bar, feed buffer trimmed to longest lookback). `fetchBinanceKlines(symbol, start, end, {intervalSeconds})` generalizes the 1s fetcher (fixes cursor advance). Commands gained `--bar-interval=1s|1m` + interval-aware hour caps; `backtest:walkforward` on 1m runs live-config-only (no 1s-tuned sweep grid). Cache-window COVERAGE check fixed (stale/partial caches refetch only the missing span — the Aug-20 bug that silently backfilled 495h). **Maker limits with a fill window shorter than one bar can never fill on coarse bars — engine falls back to MARKET** (live 15s window → market fills at 1m; pass `fastLimitFillSeconds >= 60` override for the maker analog). 345 unit tests.

## Walk-forward retry after vacation (2026-09-07, BTC 7×72h windows Aug 18 → Sep 7)

Nightly cron ran 16/17 nights during vacation (Aug 21 → Sep 6); missed Sep 7 01:30 (laptop off), gap filled manually with `backtest:update-cache` (BTC cache slid to now at 504h; ETH/SOL reached 423h and climb ~24h/night toward 504h).

- **Verdicts: 0/6 PASS.** Every in-sample winner collapses out-of-sample — same pattern as pre-vacation, ~4-12 trades/window means IS PF 3.25 on 11 trades is still grid noise (OOS PF 0.94). Window w4 untestable (no config ≥10t). Best OOS nets on the fresh vacation-period windows (w1, w6): −0.15%, −0.43%.
- **Live config on freshest window (Sep 4–7):** −0.01% net, 1 trade (+0.09% via momentum-reversal exit), buy&hold +0.33%. Flat, as designed (very selective).
- Bottom line: ~38 days of 1s data still cannot certify. 1m-klines engine (multi-year) remains the only honest path.
- **Bug found (loadSamples resume logic, `backtest_walkforward.ts` + `backtest.ts`)**: when a stale window cache file exists, resume-from-partial backfills the ENTIRE gap from the stale file's last sample to now, ignoring the requested window size. First walk-forward attempt silently produced 219h "72h windows" of overlapping garbage (787k samples each). Walk-forward must run with `--fresh` AFTER deleting the `*_wf*` cache files. The `backtest` 72h run similarly backfilled 495h (1.78M samples). Resume should be bounded by `hours` (cap merge at requested window), not unbounded.
- Also: two `fast-algo-service.spec.ts` unit-test processes hung since Aug 21 (17 days) — killed 2026-09-07.

## Toolchain
- **Runtime: Bun 1.4.0-canary** (`bun ace.js ...`, `bun run test`). Works end-to-end after the fixes documented in AGENTS.md: inlined tsconfig (no `extends`), `packages/better-sqlite3` shim (bun:sqlite under Bun, node:sqlite under Node), `bunfig-preload.ts` (jsonschema resolveUrl + execa refCounted patches).
- **Node v24 still works** (265/265) — same shim uses node:sqlite there. Node ≥ 22.5 required (node:sqlite).
- v26 remains broken (ts-exec loader / module.register) — do NOT use.

## Shipped & committed on master (265 unit tests green on BOTH bun and node v24)
- FastStrategy pure core; trend mode; regime gate; intrabar fills; sweep + walk-forward commands; risk rails (migration 17); live/backtest parity fix; maker execution + vol targeting + TCA (migration 18, applied to dev DB).

## Calibration applied to `algo_configs` (id=1) 2026-08-21
```sql
UPDATE algo_configs SET fast_maker_execution=1, fast_limit_fill_seconds=15,
  fast_limit_offset_pct=0.05, fast_maker_fee_pct=0.0008, fast_vol_target_pct=50,
  fast_vol_target_window_seconds=3600, fast_vol_target_max_mult=2 WHERE id=1;
```

## 10-round optimization sweep (2026-08-21, applied to `algo_configs` id=1)
- Applied full stack (in-sample BTC 504h: 9t, WR 44.4%, PF 5.39, net +0.84% — vs pre-round +0.42%/PF 1.92; ETH 72h: PF 6.46, +1.10% vs 3.22):
  - `fast_exit_reversal_pct` −0.3 → **−0.5** (biggest lever: kills reversal-exit churn; alone PF 4.10/+0.75%)
  - `fast_vol_target_pct` 50 → **30** (PF 2.57/+0.50%)
  - `fast_cooldown_seconds` 1800 → **7200** (WR 63.6%, PF 2.45/+0.52%)
  - `fast_trend_slope_pct` 0.1 → **0.3** (PF 2.24/+0.48%)
  - `fast_trailing_stop_pct`/`fast_trailing_activate_pct` 2.0/1.5 → **3.0/2.0** (wider trail lets winners run)
  - Kept: SL 1.0, EMA 900, regime slope 0.5, trend mode, maker execution.
- Rejected: slope window 900 (PF 10.85 but 6t — too thin), regime 0.65 (PF 2.58 but net −0.07pp), SL 2.0 (no gain in stack), EMA 600/1800/3600, trail 1.0/1.5, vol-target 70/100.
- OOS: still no walk-forward PASS (6-9 trades/21d), BUT per-window profile transformed: worst window −0.20%, 4/6 positive — chop bleed (was −1.97% windows) eliminated. Trade-off: very selective (~1 trade/2 days); certify on more data before trusting the magnitude.
- NOTE: `updated_at` must be written as `datetime('now')` string, not `Date.now()` number — lucid's date_time consume rejects numeric values (broke AlgoConfig reads until fixed).

## Regime gate calibrated (2026-08-21, applied to `algo_configs` id=1)
- `fast_regime_slope_min_pct` 0.3 → **0.5** (ema 3600 / slope window 3600 unchanged). Applied 2026-08-21.
- Evidence (BTC 504h in-window): gate was a NO-OP at 0.3 (30 trades = trend-mode baseline, never bound once in 21d). At 0.5: 14 trades, WR 50%, PF 1.92, net +0.42% (vs 30t / 23.3% / 0.79 / −0.68% at 0.3; vs 66t / 19.7% / 0.59 / −1.46% with gate off). ETH 72h: PF 2.03 → 3.22. Slope 0.8: PF 2.36 but only 9t (+0.27%); 1.2/2.0 over-tight. Slope window 7200 worse (0.92); ema 7200 similar but fewer trades.
- mom30 (`fast_momentum_seconds` 30) verified +0.88% PF 1.72 in-window but **0/4 OOS PASS** in walk-forward (nets −0.73/−1.97/−0.23/−2.26) → NOT applied, trend-window luck.
- Combo mom30+regime0.5: PF 2.00 in-window, 0/2 OOS PASS, sparse trades — not applied.
- **Certification limit**: regime-tight configs drop below 10 trades per 72h window → walk-forward can't validate them on 21 days of 1s data. Only multi-month data (1m klines or accumulated 1s history) can certify.

## Month-long validation (2026-08-21, BTC 504h = 21 days, 1,814,400 samples, cache `backtests/cache/BTC_1s_504h_v2.json`)
- `backtest:sweep --symbol=BTC --hours=504 --min-trades=10` → **baseline (live config) NEGATIVE: 30 trades, WR 23.3%, PF 0.79, net −0.68%, maxDD 1.13%**. Buy&hold +12.06%.
- Only one positive row: momentum window 30s → PF 1.72, +0.71% (17 trades) — thin.
- Verdict: **the strategy loses money over a full month**. It only wins in the recent trending window. Not deployable as-is; needs a regime model that stays OUT of chop, or it is not worth running.
- Maker execution + vol targeting improve the trending window but do NOT rescue the month picture.

## Next steps
1. Full stack is live — watch live PnL vs the −0.68%/21d month baseline. Expect ~1 trade/2 days, flat-ish equity with a few trend winners.
2. Re-verify after more 1s history accumulates: walk-forward needs ≥10 trades/window; ~2-3 more weeks of cache accumulation makes the stack testable.
3. Longer-horizon validation: adapt BacktestEngine to Binance 1m klines (multi-year) — the only honest certification path; 1s data is one-regime-sample thin.
4. If the stack holds OOS: re-open mom30 combo (in-window PF 2.00).
