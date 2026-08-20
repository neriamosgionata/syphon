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

## Month-long validation (2026-08-21, BTC 504h = 21 days, 1,814,400 samples, cache `backtests/cache/BTC_1s_504h_v2.json`)
- `backtest:sweep --symbol=BTC --hours=504 --min-trades=10` → **baseline (live config) NEGATIVE: 30 trades, WR 23.3%, PF 0.79, net −0.68%, maxDD 1.13%**. Buy&hold +12.06%.
- Only one positive row: momentum window 30s → PF 1.72, +0.71% (17 trades) — thin.
- Verdict: **the strategy loses money over a full month**. It only wins in the recent trending window. Not deployable as-is; needs a regime model that stays OUT of chop, or it is not worth running.
- Maker execution + vol targeting improve the trending window but do NOT rescue the month picture.

## Next steps
1. Decide: abandon the fast algo as primary strategy, or invest in regime classification (the −0.68% month is essentially all flat-market bleed: 5/6 windows ≈ 0, one window −1%).
2. Re-run 504h sweep with `--config '{"fastMomentumWindowSeconds":30}'` to sanity-check the single positive row.
3. If kept: tighten `fast_regime_*` gates (0 = off currently) and re-validate on the 504h window.
4. Commits: everything except `packages/better-sqlite3`, `bunfig.toml`, `bunfig-preload.ts`, `bun.lock` is on master.
