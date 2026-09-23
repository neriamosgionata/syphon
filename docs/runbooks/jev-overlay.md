# Jev Overlay Runbook — Fast Intraday Algo

Operator runbook for the Jev advisory overlay on the fast intraday line.
Jev scores entries, gates, and sizing as probabilities; the deterministic
strategy stays the execution authority, exits stay deterministic, and every
score is recorded for honest replay. Nothing here places an order Jev
commanded — Jev cannot command orders.

## Call policy and load model (U7)

- One batched call per symbol per 10s tick at most, all questions inside.
- A fresh context is reused for ~60s instead of re-scoring every tick
  (same precedent as the 60s sentiment cache), so steady-state load is
  about one call per symbol per minute, not six.
- Load ceiling: `symbols × 1440 calls/day` at full cadence
  (3 symbols ≈ 4320 calls/day). At ~700 input tokens per call and
  $0.042/MTok input with free output, that is about $0.13/day.
- Guardrails: per-call input cap (headlines truncate, facts never drop),
  per-day call and spend budgets with auto-downgrade to deterministic-only
  on breach, ~2s per-call timeout inside the tick deadline, no retry on
  auth errors, bounded retry on transport errors only.
- The spend formula is visible in status (`jev.budget`) and in the monitor
  report — state-size creep shows up as money before it shows up as latency.

## Activation sequence

1. **Key**: `TYPESAFE_API_KEY` in the environment (rotates without a code
   change; never logged; redacted from errors, alerts, and status).
2. **Shadow** (default): scores record to `ml_scores` with zero influence.
   Verify `jev.calls` grows in status while decisions match the
   deterministic baseline bit-for-bit.
3. **Veto-only**: `bun ace.js jev:stage --set veto_only --reason ...`
   after the shadow gate (veto-precision above 60% over 1–2 weeks).
   Requires a clear jev alert board.
4. **Live**: `bun ace.js jev:preflight` immediately before promoting, then
   `bun ace.js jev:stage --set live --reason ...`. Live without a fresh
   pass degrades to shadow automatically — enforcement without proof is
   refused, not retried into.
5. **Schedule the monitor** (external crontab, mirroring the yield line —
   deliberately no in-process trigger):
   ```cron
   15 2 * * * cd /path/to/syphon/backend && bun ace.js jev:monitor >> backtests/jev-monitor.log 2>&1
   ```

## Trip conditions and rollback

- **Latch**: calibration breach (ECE over the monitor bar), two consecutive
  negative evaluation periods, or `bun ace.js jev:stage --latch-off
  --reason ...`. Enforcement stops; deterministic trading continues.
- **Resume**: `bun ace.js jev:stage --resume --reason ...` re-enters
  shadow (alerts stay for `alerts:ack`). Promotion starts over.
- **Full rollback**: disable `fastJevGateEnabled` (or set the stage to
  shadow) — the strategy core never imports the sidecar, so removal is a
  config change, not a code change.
- **Retention**: the monitor run prunes scores older than 90 days.
  Certification windows must fit inside retention; older windows rerun
  scoreless (gate off, with notice) rather than on invented data.

## Promotion arithmetic (R9)

Shadow veto-precision, then paper P&L delta with t-statistic ≥ 2 over
≥ 100–200 trades net of the 0.26% taker fee and 10bps slippage, deflated
Sharpe above 0.95 over the declared trial population, and a walk-forward
out-of-sample pass (sweep window N with the backtest command, validate on
N+1). Threshold sweeps count every candidate toward the trial population;
profit-factor-only ranking never promotes. Any model, prompt, or threshold
change refits the gate/size pair — never reuse a pair across a new score
distribution.

## Boot and access rules

- A live overlay on a non-loopback `HOST` refuses to boot (same guard as
  the yield line). Overlay status rides the existing authenticated status
  surface — no new mutation route exists; score output is redacted (no key
  material, no full prompts, no raw error bodies).
- Live enablement additionally needs a fresh `jev:preflight` pass covering
  the credential, secret-file permissions, the scorer answering with the
  pinned model, and a clear alert board.
