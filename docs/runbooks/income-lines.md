# Income Lines Runbook — Yield Floor & Trend Evaluation

Operator runbook for the two derivative-free income lines. The implementer
built these; the operator executes the canary and the six-month evaluation.
Nothing here places a real trend order — no such code path exists.

## Scope

- **Yield floor** — Kraken Earn automation: observe by default, `YIELD_LIVE=true`
  to allocate. Mutating, gated by a fresh preflight pass.
- **Trend evaluation** — paper replay of the frozen daily-trend config over
  recorded Kraken 5m bars with latching tripwires. Never trades.

## Prerequisites

- Dedicated Earn API key: `KRAKEN_EARN_KEY` / `KRAKEN_EARN_SECRET`, permissions
  `Earn Funds` + `Query Funds`, no withdrawal permission, IP allowlisted,
  distinct from the spot trading key. On an Intermediate-verified account whose
  region returns the intended strategies.
- `backend/.env` created from README values; migrations applied
  (`bun ace.js migration:run`).
- Redis + Meilisearch up (`docker compose up -d redis meilisearch`).
  Meilisearch requires `MEILI_MASTER_KEY` from the environment.

## Yield activation sequence

1. **Observe** until at least one reward event for the target asset has been
   observed and reconciled — elapsed time alone is not an exit criterion.
   ```bash
   bun ace.js yield:tick          # hourly via crontab in production
   bun ace.js yield:status
   bun ace.js yield:report        # native-unit reward CSV
   ```
2. **Freeze a baseline** (balances, allocations, ledger cursor, local reward
   sums) — reconciliation compares post-baseline deltas only.
3. **Preflight immediately before going live**, then record it:
   ```bash
   bun ace.js yield:preflight
   ```
   A pass is recorded with a 1-hour TTL; a live tick without a fresh pass is
   refused.
4. **Confirm the fast-algo Kraken session is idle** (preflight checks it — a
   shared key means shared nonce state).
5. **Canary**: one flexible strategy at minimum size:
   ```bash
   YIELD_LIVE=true bun ace.js yield:tick
   ```
6. **First payout**: verify exactly one reward row per ledger refid, local sum
   equals ledger sum within tolerance, in-kind amount inside the APY band.
7. **Rehearse the exit path**: `bun ace.js yield:deallocate --asset=… --amount=…
   --reason=…`, verify the restored balance, re-allocate.
8. **Rehearse crash recovery**: kill the tick mid-operation; the next tick must
   adopt or escalate the non-terminal intent without double-submitting.
9. **Scale one asset at a time**, each surviving a full payout cycle. Move to
   bonded allocations only after both rehearsals pass and the unbonding horizon
   is acceptable for the buffer.

## Rollback (fixed order: disable live first, drain second)

- Before the canary: unset `YIELD_LIVE` — complete rollback.
- With funds allocated: unset `YIELD_LIVE`, then `yield:deallocate` per
  strategy, polling each to terminal and verifying free balances are restored.
- Bonded funds cannot be recovered instantly — record the unbonding expiry and
  alert.
- Partial/failed allocation: poll to terminal; if unknown, treat as in flight
  until a fresh allocations read disproves it. Never retry within the same tick.

## First-week checks (yield)

- **Hourly**: heartbeat age below two tick intervals; no new alerts; no pending
  operations; free balances at or above buffers; APY inside the band; all
  intents terminal.
- **First payout**: one reward row per refid even after re-ingest; local sum
  equals ledger sum; credited balance consistent with the reward.
- **Weekly**: reconciliation delta zero; allocations inside ceilings; export row
  count equals reward row count.
- **Trip conditions — disable live, then deallocate when exposure is wrong**:
  reconciliation mismatch beyond tolerance; an allocation the local state
  cannot explain; a non-terminal operation older than two tick intervals; a
  strategy disappearing while funds are allocated; APY below the floor across
  two weekly checks; a stale heartbeat; a failed/partial deallocation.

## Trend evaluation sequence

1. **Recording starts automatically** with the web process (5m/1h/1d closed
   bars → `bar_records`). Check coverage:
   ```bash
   bun ace.js trend:status
   ```
2. **Initial certification** over the research caches and any available Kraken
   windows:
   ```bash
   bun ace.js trend:certify --symbol=BTC --source=research --hours=2160
   bun ace.js trend:report
   ```
   Research rows are labeled research-only and never presented as Kraken-gated.
3. **Quarterly re-certification** as Kraken 5m bars accumulate
   (`--source=bar_records`); 5m Kraken certification requires ≥ 4032 bars
   (14 days) plus one day of samples.
4. **Six-month paper contract** runs automatically after each closed bar
   (5-minute cadence, skips when the store has not advanced).
5. **Tripwire halt** (2 consecutive negative months or >15% drawdown): the
   evaluation stops and alerts. Resume only with a recorded reason:
   ```bash
   bun ace.js trend:resume --reason="…"
   ```
6. **Capital deployment is a separate decision after the evaluation contract
   is met** — this plan builds the vehicle and the evidence, not execution.

## Canary evidence record (operator fills)

- [ ] Preflight pass artifact: date / command output
- [ ] Rollback rehearsal: date / observed restored balances
- [ ] Crash-recovery rehearsal: date / intent id / adoption outcome
- [ ] First reconciled reward: date / refid / amount

## HTTP surface

Read-only, loopback-only: `GET /api/yield/status`, `GET /api/yield/alerts`,
`GET /api/trend/status`. No mutating income route exists; every mutation is
CLI-only.
