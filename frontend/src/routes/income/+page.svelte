<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let yieldStatus: any = $state(null);
  let alerts: any[] = $state([]);
  let trendStatus: any = $state(null);
  let loading = $state(true);
  let error = $state('');

  const staleHeartbeat = $derived(Boolean(yieldStatus?.lastTick?.stale));
  const unacknowledged = $derived(alerts.filter((a: any) => a.acknowledged_at === null));
  const tripHalted = $derived(trendStatus?.trip?.state === 'halted');
  const preflightFresh = $derived(Boolean(yieldStatus?.preflight?.fresh));
  const unhealthy = $derived(staleHeartbeat || unacknowledged.length > 0 || tripHalted);

  async function load() {
    loading = true;
    error = '';
    try {
      const [y, a, t] = await Promise.all([
        api.yieldStatus(),
        api.yieldAlerts(),
        api.trendStatus(),
      ]);
      yieldStatus = y;
      alerts = a.alerts ?? [];
      trendStatus = t;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load income status';
    }
    loading = false;
  }

  function fmtTime(value: number | null | undefined): string {
    if (!value) return 'never';
    return new Date(value).toLocaleString();
  }

  function fmt(value: number | null | undefined, digits = 4): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toFixed(digits);
  }

  onMount(load);
</script>

<svelte:head>
  <title>Income - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <div>
      <h1>Income</h1>
      <p class="subtitle">Kraken Earn yield floor and the slow trend paper evaluation</p>
    </div>
    <button class="btn" onclick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
  </div>

  {#if error}
    <div class="banner error">Failed to load: {error}</div>
  {/if}

  {#if unhealthy}
    <div class="banner error">
      <strong>Unhealthy:</strong>
      {#if staleHeartbeat}yield heartbeat is stale. {/if}
      {#if unacknowledged.length > 0}{unacknowledged.length} unacknowledged alert(s). {/if}
      {#if tripHalted}trend evaluation is halted by a tripwire. {/if}
    </div>
  {:else if !loading}
    <div class="banner ok">All checks nominal.</div>
  {/if}

  <div class="card">
    <h2>Yield floor <span class="mode">{yieldStatus?.lastTick?.detail?.live ? 'live' : 'observe'}</span></h2>
    <div class="meta">
      <span>Last tick: {fmtTime(yieldStatus?.lastTick?.at)}</span>
      <span class:warn={!preflightFresh}>Preflight: {yieldStatus?.preflight?.state ?? 'none'}{preflightFresh ? ' (fresh)' : ' (not fresh)'}</span>
    </div>

    <h3>Allocations</h3>
    {#if (yieldStatus?.allocations ?? []).length === 0}
      <p class="muted">No allocations recorded yet.</p>
    {:else}
      <table>
        <thead>
          <tr><th>Asset</th><th>Strategy</th><th>Lock</th><th>Allocated</th><th>Pending</th><th>APY</th></tr>
        </thead>
        <tbody>
          {#each yieldStatus.allocations as row}
            <tr>
              <td>{row.asset}</td>
              <td class="mono">{row.strategyId}</td>
              <td>{row.lockType}</td>
              <td>{fmt(row.allocatedNative, 8)}</td>
              <td>{fmt(row.pendingNative, 8)}</td>
              <td>{row.apyLow === null ? '—' : `${(row.apyLow * 100).toFixed(2)}%`}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <h3>Open operations</h3>
    {#if (yieldStatus?.openOperations ?? []).length === 0}
      <p class="muted">None in flight.</p>
    {:else}
      <ul>
        {#each yieldStatus.openOperations as op}
          <li>#{op.id} {op.type} {op.strategyId} — {op.status}</li>
        {/each}
      </ul>
    {/if}

    <h3>Realized rewards (30d)</h3>
    {#if (yieldStatus?.realized ?? []).length === 0}
      <p class="muted">No reconciled rewards yet.</p>
    {:else}
      <ul>
        {#each yieldStatus.realized as entry}
          <li>{entry.asset}: {fmt(entry.amount, 8)} over {entry.rewards} payout(s)</li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <h2>Trend evaluation <span class="mode">{tripHalted ? 'halted' : 'paper'}</span></h2>
    <div class="meta">
      <span class:warn={tripHalted}>Tripwire: {trendStatus?.trip?.state ?? 'ok'}{trendStatus?.trip?.reasons?.length ? ` — ${trendStatus.trip.reasons.join('; ')}` : ''}</span>
      <span class:warn={trendStatus?.lastTick?.stale}>Last run: {fmtTime(trendStatus?.lastTick?.at)}</span>
    </div>

    {#if (trendStatus?.evaluations ?? []).length === 0}
      <p class="muted">No evaluations yet — the recorder is accumulating Kraken bars.</p>
    {:else}
      <table>
        <thead>
          <tr><th>#</th><th>Symbol</th><th>State</th><th>Bars</th><th>Net</th><th>Max DD</th><th>Green months</th><th>Trades</th></tr>
        </thead>
        <tbody>
          {#each trendStatus.evaluations as evaluation}
            <tr class:warn={evaluation.provisional}>
              <td>{evaluation.id}</td>
              <td>{evaluation.symbol}</td>
              <td>{evaluation.state}{evaluation.provisional ? ' (provisional)' : ''}</td>
              <td>{evaluation.bars}</td>
              <td>{fmt(evaluation.netReturnPct, 2)}%</td>
              <td>{fmt(evaluation.maxDrawdownPct, 2)}%</td>
              <td>{evaluation.greenMonths ?? '—'}</td>
              <td>{evaluation.tradeCount}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <div class="card">
    <h2>Alerts</h2>
    {#if alerts.length === 0}
      <p class="muted">No alerts.</p>
    {:else}
      <ul class="alerts">
        {#each alerts as alert}
          <li class:unack={alert.acknowledged_at === null}>
            <span class="sev {alert.severity}">{alert.severity}</span>
            <span class="mono">{alert.code}</span> {alert.message}
            {#if alert.acknowledged_at === null}<span class="tag">unacknowledged</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  h1 { margin: 0; }
  .subtitle { color: var(--text-muted); margin: 0.25rem 0 0; font-size: 0.9rem; }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1.25rem;
    margin-bottom: 1.5rem;
  }
  h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
  h3 { margin: 1.25rem 0 0.5rem; font-size: 0.95rem; color: var(--text-muted); }
  .mode {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
    margin-left: 0.5rem;
  }
  .meta { display: flex; gap: 1.5rem; flex-wrap: wrap; color: var(--text-muted); font-size: 0.85rem; }
  .banner { border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 1.25rem; font-size: 0.9rem; }
  .banner.error { background: rgba(220, 38, 38, 0.12); border: 1px solid var(--red); color: var(--text); }
  .banner.ok { background: rgba(34, 197, 94, 0.1); border: 1px solid var(--green); color: var(--text); }
  .warn { color: var(--yellow); }
  .muted { color: var(--text-muted); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
  th { color: var(--text-muted); font-weight: 600; }
  tr.warn td { color: var(--yellow); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  ul { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; }
  .alerts li.unack { color: var(--yellow); }
  .sev { text-transform: uppercase; font-size: 0.7rem; margin-right: 0.4rem; }
  .sev.critical { color: var(--red); }
  .sev.warning { color: var(--yellow); }
  .sev.info { color: var(--text-muted); }
  .tag { margin-left: 0.5rem; font-size: 0.7rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.4rem; }
  .btn {
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 0.4rem;
    padding: 0.45rem 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.6; cursor: default; }
</style>
