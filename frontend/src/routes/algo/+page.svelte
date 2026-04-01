<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { onSSE } from '$lib/sse';
  import StatCard from '$lib/components/StatCard.svelte';

  let config: any = $state(null);
  let stats: any = $state(null);
  let positions: any[] = $state([]);
  let decisions: any = $state(null);
  let loading = $state(true);
  let saving = $state(false);
  let running = $state(false);
  let toggling = $state(false);

  // Config form state
  let form: any = $state({});
  let showConfig = $state(false);

  // Decision filters
  let decisionFilter = $state('');
  let decisionSymbol = $state('');
  let decisionPage = $state(1);

  // Position filter
  let positionStatus = $state('open');

  let enabled = $derived(config?.enabled ?? false);
  let dryRun = $derived(config?.dry_run ?? config?.dryRun ?? true);

  async function load() {
    loading = true;
    try {
      const [c, s, p, d] = await Promise.all([
        api.algoConfig().catch(() => null),
        api.algoStats().catch(() => null),
        api.algoPositions({ status: positionStatus }).catch(() => []),
        loadDecisions(),
      ]);
      config = c;
      stats = s;
      positions = Array.isArray(p) ? p : [];
      if (c) resetForm(c);
    } catch {}
    loading = false;
  }

  async function loadDecisions() {
    const params: Record<string, string> = {
      page: String(decisionPage),
      limit: '30',
    };
    if (decisionFilter) params.decision = decisionFilter;
    if (decisionSymbol) params.symbol = decisionSymbol.toUpperCase();
    const result = await api.algoDecisions(params).catch(() => ({ data: [] }));
    decisions = result;
    return result;
  }

  async function loadPositions() {
    positions = await api.algoPositions({ status: positionStatus }).catch(() => []);
  }

  function resetForm(c: any) {
    form = {
      dry_run: c.dry_run ?? c.dryRun ?? true,
      broker: c.broker ?? 'ibkr',
      entry_score_threshold: c.entry_score_threshold ?? c.entryScoreThreshold ?? 30,
      min_conviction: c.min_conviction ?? c.minConviction ?? 0.4,
      min_articles: c.min_articles ?? c.minArticles ?? 1,
      allowed_regimes: c.allowed_regimes ?? c.allowedRegimes ?? ['trending_up', 'ranging'],
      max_positions: c.max_positions ?? c.maxPositions ?? 10,
      max_exposure_pct: c.max_exposure_pct ?? c.maxExposurePct ?? 0.80,
      max_single_position_pct: c.max_single_position_pct ?? c.maxSinglePositionPct ?? 0.15,
      daily_loss_limit_pct: c.daily_loss_limit_pct ?? c.dailyLossLimitPct ?? 0.03,
      exit_score_threshold: c.exit_score_threshold ?? c.exitScoreThreshold ?? -10,
      max_holding_days: c.max_holding_days ?? c.maxHoldingDays ?? 30,
      order_type: c.order_type ?? c.orderType ?? 'MKT',
      time_in_force: c.time_in_force ?? c.timeInForce ?? 'DAY',
      cooldown_minutes: c.cooldown_minutes ?? c.cooldownMinutes ?? 5,
      excluded_symbols: (c.excluded_symbols ?? c.excludedSymbols ?? []).join(', '),
    };
  }

  async function toggle() {
    toggling = true;
    try {
      if (enabled) {
        await api.algoDisable();
      } else {
        await api.algoEnable();
      }
      config = await api.algoConfig();
      if (config) resetForm(config);
    } catch {}
    toggling = false;
  }

  async function saveConfig() {
    saving = true;
    try {
      const payload: any = { ...form };
      payload.excluded_symbols = form.excluded_symbols
        ? form.excluded_symbols.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      payload.min_conviction = parseFloat(payload.min_conviction);
      payload.max_exposure_pct = parseFloat(payload.max_exposure_pct);
      payload.max_single_position_pct = parseFloat(payload.max_single_position_pct);
      payload.daily_loss_limit_pct = parseFloat(payload.daily_loss_limit_pct);
      config = await api.algoUpdateConfig(payload);
      if (config) resetForm(config);
    } catch {}
    saving = false;
  }

  async function triggerRun() {
    running = true;
    try {
      await api.algoRun();
    } catch {}
    setTimeout(() => { running = false; }, 3000);
  }

  async function forceClose(id: number, symbol: string) {
    if (!confirm(`Force close ${symbol} position on next algo run?`)) return;
    try {
      await api.algoForceClose(id);
      await loadPositions();
    } catch {}
  }

  function toggleRegime(regime: string) {
    const current = form.allowed_regimes || [];
    if (current.includes(regime)) {
      form.allowed_regimes = current.filter((r: string) => r !== regime);
    } else {
      form.allowed_regimes = [...current, regime];
    }
  }

  function formatTime(ts: string) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  }

  function formatPnl(v: number | null) {
    if (v == null) return '-';
    const sign = v >= 0 ? '+' : '';
    return `${sign}$${v.toFixed(2)}`;
  }

  function formatPct(v: number | null) {
    if (v == null) return '-';
    return `${(v * 100).toFixed(1)}%`;
  }

  onMount(() => {
    load();
    return onSSE('job_finished', (data: any) => {
      if (data.queue === 'algo-trading') {
        setTimeout(load, 1000);
      }
    });
  });
</script>

<div class="page">
  <div class="header">
    <div>
      <h1>Algo Trading</h1>
      {#if config?.disabled_reason || config?.disabledReason}
        <p class="disabled-reason">{config.disabled_reason || config.disabledReason}</p>
      {/if}
    </div>
    <div class="header-actions">
      <button class="run-btn" onclick={triggerRun} disabled={running}>
        {running ? 'Queued...' : 'Run Now'}
      </button>
      <button
        class="toggle-btn"
        class:enabled={enabled}
        class:disabled={!enabled}
        onclick={toggle}
        disabled={toggling}
      >
        <span class="dot" class:on={enabled}></span>
        {enabled ? 'ENABLED' : 'DISABLED'}
      </button>
    </div>
  </div>

  <!-- Status Cards -->
  <div class="stats-row">
    <StatCard label="Status" value={enabled ? (dryRun ? 'DRY RUN' : 'LIVE') : 'DISABLED'} />
    <StatCard label="Open Positions" value={stats?.openPositions ?? 0} />
    <StatCard label="Total P&L" value={stats ? `$${stats.totalPnl?.toFixed(2) ?? '0.00'}` : '-'} />
    <StatCard label="Win Rate" value={stats?.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : '-'} />
  </div>

  <!-- Configuration -->
  <div class="card">
    <button class="card-header clickable" onclick={() => showConfig = !showConfig}>
      <h2>Configuration</h2>
      <span class="chevron" class:open={showConfig}></span>
    </button>
    {#if showConfig}
      <div class="config-form">
        <div class="form-grid">
          <label class="field">
            <span>Dry Run</span>
            <select bind:value={form.dry_run}>
              <option value={true}>Yes (log only)</option>
              <option value={false}>No (execute trades)</option>
            </select>
          </label>
          <label class="field">
            <span>Broker</span>
            <select bind:value={form.broker}>
              <option value="ibkr">IBKR</option>
              <option value="kraken">Kraken</option>
            </select>
          </label>
          <label class="field">
            <span>Entry Score Threshold</span>
            <input type="number" bind:value={form.entry_score_threshold} min="1" max="100" />
          </label>
          <label class="field">
            <span>Min Conviction</span>
            <input type="number" bind:value={form.min_conviction} min="0" max="1" step="0.05" />
          </label>
          <label class="field">
            <span>Min Articles</span>
            <input type="number" bind:value={form.min_articles} min="0" max="50" />
          </label>
          <label class="field">
            <span>Exit Score Threshold</span>
            <input type="number" bind:value={form.exit_score_threshold} min="-100" max="0" />
          </label>
          <label class="field">
            <span>Max Positions</span>
            <input type="number" bind:value={form.max_positions} min="1" max="50" />
          </label>
          <label class="field">
            <span>Max Exposure %</span>
            <input type="number" bind:value={form.max_exposure_pct} min="0.1" max="1" step="0.05" />
          </label>
          <label class="field">
            <span>Max Single Position %</span>
            <input type="number" bind:value={form.max_single_position_pct} min="0.01" max="0.5" step="0.01" />
          </label>
          <label class="field">
            <span>Daily Loss Limit %</span>
            <input type="number" bind:value={form.daily_loss_limit_pct} min="0.01" max="0.2" step="0.01" />
          </label>
          <label class="field">
            <span>Max Holding Days</span>
            <input type="number" bind:value={form.max_holding_days} min="1" max="365" />
          </label>
          <label class="field">
            <span>Order Type</span>
            <select bind:value={form.order_type}>
              <option value="MKT">Market</option>
              <option value="LMT">Limit</option>
            </select>
          </label>
          <label class="field">
            <span>Time in Force</span>
            <select bind:value={form.time_in_force}>
              <option value="DAY">DAY</option>
              <option value="GTC">GTC</option>
            </select>
          </label>
          <label class="field">
            <span>Cooldown (min)</span>
            <input type="number" bind:value={form.cooldown_minutes} min="1" max="60" />
          </label>
        </div>

        <div class="regimes-row">
          <span class="field-label">Allowed Regimes</span>
          <div class="regime-chips">
            {#each ['trending_up', 'trending_down', 'ranging', 'volatile'] as regime}
              <button
                class="chip"
                class:active={form.allowed_regimes?.includes(regime)}
                onclick={() => toggleRegime(regime)}
              >{regime.replace('_', ' ')}</button>
            {/each}
          </div>
        </div>

        <label class="field full">
          <span>Excluded Symbols (comma-separated)</span>
          <input type="text" bind:value={form.excluded_symbols} placeholder="e.g., TSLA, GME" />
        </label>

        <button class="save-btn" onclick={saveConfig} disabled={saving}>
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>
    {/if}
  </div>

  <!-- Open Positions -->
  <div class="card">
    <div class="card-header">
      <h2>Positions</h2>
      <div class="tab-row">
        {#each ['open', 'closing', 'closed', 'all'] as s}
          <button class="tab" class:active={positionStatus === s}
            onclick={() => { positionStatus = s; loadPositions(); }}>{s}</button>
        {/each}
      </div>
    </div>
    {#if positions.length === 0}
      <p class="empty">No {positionStatus} positions</p>
    {:else}
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Entry</th>
              <th>Current</th>
              <th>SL</th>
              <th>TP</th>
              <th>P&L</th>
              <th>Days</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each positions as pos}
              {@const pnl = pos.unrealized_pnl ?? pos.realized_pnl ?? null}
              <tr>
                <td class="symbol">{pos.symbol}</td>
                <td><span class="side-badge" class:buy={pos.side === 'BUY'} class:sell={pos.side === 'SELL'}>{pos.side}</span></td>
                <td>{pos.quantity}</td>
                <td>${Number(pos.entry_price ?? pos.entryPrice).toFixed(2)}</td>
                <td>${Number(pos.current_price ?? pos.currentPrice ?? pos.entry_price ?? pos.entryPrice).toFixed(2)}</td>
                <td>${Number(pos.stop_loss ?? pos.stopLoss).toFixed(2)}</td>
                <td>${Number(pos.take_profit ?? pos.takeProfit).toFixed(2)}</td>
                <td class:positive={pnl > 0} class:negative={pnl < 0}>{formatPnl(pnl)}</td>
                <td>{pos.days_held ?? pos.daysHeld ?? '-'}</td>
                <td><span class="status-badge {pos.status}">{pos.status}</span></td>
                <td>
                  {#if pos.status === 'open' && !(pos.force_close ?? pos.forceClose)}
                    <button class="close-btn" onclick={() => forceClose(pos.id, pos.symbol)}>Close</button>
                  {:else if pos.force_close ?? pos.forceClose}
                    <span class="pending-close">closing...</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <!-- Performance Stats -->
  {#if stats && stats.totalTrades > 0}
    <div class="card">
      <h2 class="card-header">Performance</h2>
      <div class="perf-grid">
        <div class="perf-item">
          <span class="perf-label">Total Trades</span>
          <span class="perf-value">{stats.totalTrades}</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Win / Loss</span>
          <span class="perf-value">{stats.winCount} / {stats.lossCount}</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Win Rate</span>
          <span class="perf-value">{(stats.winRate * 100).toFixed(1)}%</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Total P&L</span>
          <span class="perf-value" class:positive={stats.totalPnl > 0} class:negative={stats.totalPnl < 0}>
            {formatPnl(stats.totalPnl)}
          </span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Avg Return</span>
          <span class="perf-value">{stats.avgReturnPct.toFixed(2)}%</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Profit Factor</span>
          <span class="perf-value">{stats.profitFactor === Infinity ? 'Inf' : stats.profitFactor.toFixed(2)}</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Max Drawdown</span>
          <span class="perf-value">{(stats.maxDrawdown * 100).toFixed(1)}%</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Avg Hold Days</span>
          <span class="perf-value">{stats.avgHoldingDays.toFixed(1)}</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Largest Win</span>
          <span class="perf-value positive">{formatPnl(stats.largestWin)}</span>
        </div>
        <div class="perf-item">
          <span class="perf-label">Largest Loss</span>
          <span class="perf-value negative">{formatPnl(stats.largestLoss)}</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Decision Log -->
  <div class="card">
    <div class="card-header">
      <h2>Decision Log</h2>
      <div class="decision-filters">
        <select bind:value={decisionFilter} onchange={() => { decisionPage = 1; loadDecisions(); }}>
          <option value="">All</option>
          <option value="enter">Enter</option>
          <option value="exit">Exit</option>
          <option value="hold">Hold</option>
          <option value="skip">Skip</option>
        </select>
        <input type="text" placeholder="Symbol" bind:value={decisionSymbol}
          onkeydown={(e) => { if (e.key === 'Enter') { decisionPage = 1; loadDecisions(); }}} />
      </div>
    </div>
    {#if !decisions?.data?.length}
      <p class="empty">No decisions recorded yet</p>
    {:else}
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Run</th>
              <th>Symbol</th>
              <th>Decision</th>
              <th>Score</th>
              <th>Conviction</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {#each decisions.data as d}
              <tr class="decision-row {d.decision}">
                <td class="nowrap">{formatTime(d.created_at ?? d.createdAt)}</td>
                <td class="run-id">{(d.run_id ?? d.runId ?? '').slice(0, 8)}</td>
                <td class="symbol">{d.symbol}</td>
                <td>
                  <span class="decision-badge {d.decision}">{d.decision}</span>
                </td>
                <td>{d.composite_score ?? d.compositeScore ?? '-'}</td>
                <td>{d.conviction != null ? `${(d.conviction * 100).toFixed(0)}%` : '-'}</td>
                <td class="reason">{d.reason}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if decisions.meta?.last_page > 1}
        <div class="pagination">
          <button disabled={decisionPage <= 1}
            onclick={() => { decisionPage--; loadDecisions(); }}>Prev</button>
          <span>Page {decisionPage} of {decisions.meta.last_page}</span>
          <button disabled={decisionPage >= decisions.meta.last_page}
            onclick={() => { decisionPage++; loadDecisions(); }}>Next</button>
        </div>
      {/if}
    {/if}
  </div>

  {#if config}
    <p class="last-run">Last run: {config.last_run_at || config.lastRunAt ? formatTime(config.last_run_at || config.lastRunAt) : 'Never'}</p>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 1.5rem; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; }
  .header h1 { font-size: 1.5rem; font-weight: 700; }
  .header-actions { display: flex; gap: 0.75rem; align-items: center; }
  .disabled-reason { color: var(--text-danger, #ef4444); font-size: 0.85rem; margin-top: 0.25rem; }

  .toggle-btn {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 1rem; border-radius: 6px;
    font-weight: 700; font-size: 0.85rem; letter-spacing: 0.05em;
    border: 2px solid; cursor: pointer; transition: all 0.2s;
  }
  .toggle-btn.enabled { background: rgba(34,197,94,0.15); border-color: #22c55e; color: #22c55e; }
  .toggle-btn.disabled { background: rgba(239,68,68,0.15); border-color: #ef4444; color: #ef4444; }
  .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: #ef4444; transition: background 0.2s;
  }
  .dot.on { background: #22c55e; }

  .run-btn {
    padding: 0.5rem 1rem; border-radius: 6px;
    background: var(--accent, #3b82f6); color: white; font-weight: 600;
    border: none; cursor: pointer;
  }
  .run-btn:disabled { opacity: 0.5; }

  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }

  .card {
    background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #2a2a40);
    border-radius: 8px; overflow: hidden;
  }
  .card-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 1rem 1.25rem; border-bottom: 1px solid var(--border, #2a2a40);
    background: none; border-top: none; border-left: none; border-right: none;
    width: 100%; text-align: left; color: inherit;
  }
  .card-header.clickable { cursor: pointer; }
  .card-header h2 { font-size: 1rem; font-weight: 600; margin: 0; }
  .chevron { font-size: 0.8rem; transition: transform 0.2s; }
  .chevron::after { content: '\25BC'; }
  .chevron.open { transform: rotate(180deg); }

  .config-form { padding: 1.25rem; }
  .form-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem; margin-bottom: 1rem;
  }
  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .field span, .field-label { font-size: 0.8rem; color: var(--text-muted, #888); }
  .field.full { grid-column: 1 / -1; }
  .field input, .field select {
    padding: 0.4rem 0.6rem; border-radius: 4px;
    background: var(--bg, #0f0f1a); border: 1px solid var(--border, #2a2a40);
    color: var(--text, #e0e0e0); font-size: 0.9rem;
  }
  .regimes-row {
    display: flex; align-items: center; gap: 0.75rem;
    margin-bottom: 1rem; flex-wrap: wrap;
  }
  .regime-chips { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .chip {
    padding: 0.3rem 0.7rem; border-radius: 20px; font-size: 0.8rem;
    border: 1px solid var(--border, #2a2a40); cursor: pointer;
    background: transparent; color: var(--text-muted, #888);
    transition: all 0.15s;
  }
  .chip.active { background: var(--accent, #3b82f6); color: white; border-color: var(--accent, #3b82f6); }
  .save-btn {
    padding: 0.5rem 1.5rem; border-radius: 6px;
    background: var(--accent, #3b82f6); color: white; font-weight: 600;
    border: none; cursor: pointer; margin-top: 0.5rem;
  }
  .save-btn:disabled { opacity: 0.5; }

  .tab-row { display: flex; gap: 0.25rem; }
  .tab {
    padding: 0.3rem 0.7rem; border-radius: 4px; font-size: 0.8rem;
    background: transparent; border: 1px solid var(--border, #2a2a40);
    color: var(--text-muted, #888); cursor: pointer; text-transform: capitalize;
  }
  .tab.active { background: var(--accent, #3b82f6); color: white; border-color: var(--accent, #3b82f6); }

  .table-wrapper { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 0.6rem 0.75rem; color: var(--text-muted, #888); font-weight: 500; border-bottom: 1px solid var(--border, #2a2a40); }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border, #2a2a40); }
  .symbol { font-weight: 600; }
  .nowrap { white-space: nowrap; }
  .run-id { font-family: monospace; font-size: 0.75rem; color: var(--text-muted, #888); }
  .reason { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem; color: var(--text-muted, #888); }

  .side-badge { padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }
  .side-badge.buy { background: rgba(34,197,94,0.15); color: #22c55e; }
  .side-badge.sell { background: rgba(239,68,68,0.15); color: #ef4444; }

  .status-badge { padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.75rem; }
  .status-badge.open { background: rgba(59,130,246,0.15); color: #3b82f6; }
  .status-badge.closing { background: rgba(234,179,8,0.15); color: #eab308; }
  .status-badge.closed { background: rgba(107,114,128,0.15); color: #6b7280; }

  .decision-badge { padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }
  .decision-badge.enter { background: rgba(34,197,94,0.15); color: #22c55e; }
  .decision-badge.exit { background: rgba(234,179,8,0.15); color: #eab308; }
  .decision-badge.hold { background: rgba(107,114,128,0.15); color: #6b7280; }
  .decision-badge.skip { background: rgba(107,114,128,0.08); color: #4b5563; }
  tr.decision-row.skip td { opacity: 0.6; }

  .close-btn {
    padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem;
    background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid #ef4444;
    cursor: pointer;
  }
  .pending-close { font-size: 0.75rem; color: #eab308; }

  .positive { color: #22c55e; }
  .negative { color: #ef4444; }

  .perf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0; }
  .perf-item { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border, #2a2a40); }
  .perf-label { display: block; font-size: 0.75rem; color: var(--text-muted, #888); margin-bottom: 0.25rem; }
  .perf-value { font-size: 1.1rem; font-weight: 600; }

  .decision-filters { display: flex; gap: 0.5rem; }
  .decision-filters select, .decision-filters input {
    padding: 0.3rem 0.5rem; border-radius: 4px; font-size: 0.8rem;
    background: var(--bg, #0f0f1a); border: 1px solid var(--border, #2a2a40);
    color: var(--text, #e0e0e0);
  }
  .decision-filters input { width: 80px; }

  .pagination { display: flex; justify-content: center; align-items: center; gap: 1rem; padding: 0.75rem; }
  .pagination button {
    padding: 0.3rem 0.7rem; border-radius: 4px; font-size: 0.8rem;
    background: var(--bg, #0f0f1a); border: 1px solid var(--border, #2a2a40);
    color: var(--text, #e0e0e0); cursor: pointer;
  }
  .pagination button:disabled { opacity: 0.3; cursor: default; }
  .pagination span { font-size: 0.8rem; color: var(--text-muted, #888); }

  .empty { padding: 2rem; text-align: center; color: var(--text-muted, #888); }
  .last-run { text-align: center; font-size: 0.8rem; color: var(--text-muted, #888); }

  @media (max-width: 768px) {
    .stats-row { grid-template-columns: repeat(2, 1fr); }
    .form-grid { grid-template-columns: 1fr; }
    .header { flex-direction: column; gap: 1rem; }
  }
</style>
