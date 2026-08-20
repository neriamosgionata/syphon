# ALGO WIP — handoff (2026-08-21)

Where the algo work stands. Last session stopped mid-flight on: maker-execution + volatility-targeting calibration and full-depth validation.

**Toolchain: use node v24** (`nvm use 24`). v26 breaks `@poppinss/ts-exec`'s loader (`module.register()` removed → every ace command fails with "Invalid command exported ... Invalid URL"). No fix planned — v24 is the target runtime.

## Shipped & committed on master (all green at 265 unit tests on node v24)
- FastStrategy pure core; trend mode; regime gate; intrabar fills; sweep + walk-forward commands; risk rails (migration 17: correlated cap, risk-per-trade, loss-streak); live/backtest parity fix (1 position/symbol).
- Honest single-position results across 6×72h windows (current live config, taker fees): only the most recent trending window is positive (+0.17%, PF 2.11); 5/6 windows ≈ 0 or negative. 7×72h walk-forward: ALL verdicts FAIL. The edge is regime-lucky, not validated.

## In-flight (UNCOMMITTED — all in working tree)
**A. Maker execution + TCA + volatility targeting (migration 18, applied to dev DB):**
- `algo_configs`: `fast_maker_execution`, `fast_limit_fill_seconds` (15), `fast_limit_offset_pct` (0.05), `fast_maker_fee_pct` (0.0008), `fast_vol_target_pct`, `fast_vol_target_window_seconds` (3600), `fast_vol_target_max_mult` (2). `algo_positions.decision_price` (TCA).
- `FastStrategy.volatilityMultiplier(perSampleVolPct, targetAnnPct, maxMult)` — **target is in % annualized, e.g. 50 = 50%** (config range [0,200]).
- `BacktestEngine`: limit-fill entries (scan fill window, fill at limit, maker fee, SL/TP scaled to fill price), vol-target sizing (mult applied inside the maxSingle cap).
- `FastAlgoService`: live LIMIT entries (place → waitForFill → cancel → retry once at fresh price → skip on miss; exits stay MARKET), vol-target multiplier, `decisionPrice` persisted, waitForFill helper.
- **Calibration on ETH 72h (taker baseline +0.08%):** maker only +0.50%, maker+volTarget50 +0.92%. BTC 72h: 0.17→0.44. Flat 72h: −0.19→−0.13. BTC 36h: −0.03→+0.22. **NOT yet written to `algo_configs`** — apply:
  ```sql
  UPDATE algo_configs SET fast_maker_execution=1, fast_limit_fill_seconds=15,
    fast_limit_offset_pct=0.05, fast_maker_fee_pct=0.0008, fast_vol_target_pct=50,
    fast_vol_target_window_seconds=3600, fast_vol_target_max_mult=2 WHERE id=1;
  ```

**B. Full-depth validation (data discovery):**
- Binance 1s history ≥ 33 days (probed: 72h windows ending 10/20/30 days ago all fetched fine).
- 7×72h walk-forward (21 days): 0/6 verdicts PASS — recorded in `/tmp/opencode/wf7b.log`.
- Month-long sweep (`backtest:sweep --hours=504`) **not completed** — aborted twice. Fetcher is now resumable (checkpoint writes every 25 pages via `onProgress`); the 504h cache may exist partially at `backend/backtests/cache/BTC_1s_504h_v2.json` — rerun will resume.
- Commands: hours cap raised 72→504, walk-forward windows cap 6→12, `BinanceKlineService.MAX_PAGES` 600→2000.

## Next steps (on node v24)
1. Verify: `node ace list` → 0 errors; `TEST_SUITE=unit node ace test` → 265 green.
2. Finish `backtest:sweep --symbol=BTC --hours=504 --min-trades=10` (~5-8 min fetch, resumes from partial cache).
3. Apply the calibration SQL above.
4. Update AGENTS.md (maker/voltarget + month validation verdict).
5. Commit: migration 18 files, strategy/engine/service/commands changes, ALGO_WIP.md.

## Key evidence (for the next session)
- Maker fee delta worth ~+1.2%/3d on ETH (0.26% taker → 0.08% maker on identical trades).
- Month truth: strategy loses 5/6 windows; only recent uptrend positive. Vol targeting + maker execution don't rescue the general picture — they improve the trending window only.
- `fast_vol_target_pct` units: percent annualized (50 = 50% ann); per-second vol × √31,536,000.
