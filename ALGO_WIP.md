# ALGO WIP — handoff (2026-08-21)

Where the algo work stands. Maker-execution + volatility-targeting shipped (migration 18, committed). Month-long validation DONE: the edge is regime-lucky, not validated. Toolchain moved to Bun (see AGENTS.md "Bun runtime" section).

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
1. Regime 0.5 is live — watch live PnL vs the -0.68%/21d month baseline; it trades ~2x less, expect a quieter equity curve.
2. Re-verify after more 1s history accumulates: walk-forward needs ≥10 trades/window; ~2-3 more weeks of cache accumulation makes regime configs testable.
3. Longer-horizon validation: adapt BacktestEngine to Binance 1m klines (multi-year) — the only honest certification path; 1s data is one-regime-sample thin.
4. If regime 0.5 holds OOS: re-open mom30 + regime0.5 combo (in-window PF 2.00).
