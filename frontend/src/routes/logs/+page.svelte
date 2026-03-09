<script lang="ts">
  import { api } from '$lib/api';

  let logs = $state<any[]>([]);
  let stats = $state<any>(null);
  let total = $state(0);
  let loading = $state(true);
  let query = $state('');
  let level = $state('');
  let context = $state('');
  let page = $state(1);
  let autoRefresh = $state(true);
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  const LEVEL_COLORS: Record<string, string> = {
    trace: '#9ca3af',
    debug: '#60a5fa',
    info: '#34d399',
    warn: '#fbbf24',
    error: '#f87171',
    fatal: '#ef4444',
  };

  async function loadLogs() {
    try {
      const params: Record<string, string> = { page: String(page), per_page: '100' };
      if (query) params.q = query;
      if (level) params.level = level;
      if (context) params.context = context;
      const data = await api.logs(params);
      logs = data.logs || [];
      total = data.total || 0;
    } catch { /* ignore */ }
  }

  async function loadStats() {
    try {
      stats = await api.logStats();
    } catch { /* ignore */ }
  }

  async function loadAll() {
    loading = true;
    await Promise.all([loadLogs(), loadStats()]);
    loading = false;
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshInterval = setInterval(loadLogs, 5000);
  }

  function stopAutoRefresh() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  $effect(() => {
    loadAll();
  });

  $effect(() => {
    if (autoRefresh) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
    return () => stopAutoRefresh();
  });

  function formatTime(ts: string) {
    return new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDate(ts: string) {
    return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }
</script>

<svelte:head>
  <title>Logs - Syphon</title>
</svelte:head>

<div class="logs-page">
  <div class="header">
    <h1>Application Logs</h1>
    <div class="controls">
      <label class="auto-refresh">
        <input type="checkbox" bind:checked={autoRefresh} />
        Auto-refresh
      </label>
      <button onclick={() => loadAll()} class="btn">Refresh</button>
    </div>
  </div>

  {#if stats}
  <div class="stats-bar">
    <div class="stat">
      <span class="stat-value">{stats.totalLogs}</span>
      <span class="stat-label">Total Logs</span>
    </div>
    {#each stats.byLevel as item}
    <div class="stat">
      <span class="stat-value" style="color: {LEVEL_COLORS[item.level] || '#fff'}">{item.count}</span>
      <span class="stat-label">{item.level}</span>
    </div>
    {/each}
  </div>
  {/if}

  <div class="filters">
    <input
      type="text"
      placeholder="Search logs..."
      bind:value={query}
      onkeydown={(e) => { if (e.key === 'Enter') { page = 1; loadLogs(); } }}
    />
    <select bind:value={level} onchange={() => { page = 1; loadLogs(); }}>
      <option value="">All Levels</option>
      <option value="trace">Trace</option>
      <option value="debug">Debug</option>
      <option value="info">Info</option>
      <option value="warn">Warn</option>
      <option value="error">Error</option>
      <option value="fatal">Fatal</option>
    </select>
    <select bind:value={context} onchange={() => { page = 1; loadLogs(); }}>
      <option value="">All Contexts</option>
      {#if stats?.byContext}
        {#each stats.byContext as ctx}
          <option value={ctx.context}>{ctx.context} ({ctx.count})</option>
        {/each}
      {/if}
    </select>
    <span class="result-count">{total} results</span>
  </div>

  <div class="log-table">
    {#if loading && logs.length === 0}
      <div class="loading">Loading logs...</div>
    {:else if logs.length === 0}
      <div class="empty">No logs found</div>
    {:else}
      <table>
        <thead>
          <tr>
            <th class="col-time">Time</th>
            <th class="col-level">Level</th>
            <th class="col-context">Context</th>
            <th class="col-message">Message</th>
          </tr>
        </thead>
        <tbody>
          {#each logs as log}
          <tr class="log-row level-{log.level}">
            <td class="col-time">
              <span class="date">{formatDate(log.timestamp)}</span>
              <span class="time">{formatTime(log.timestamp)}</span>
            </td>
            <td class="col-level">
              <span class="level-badge" style="color: {LEVEL_COLORS[log.level] || '#fff'}">
                {log.level?.toUpperCase()}
              </span>
            </td>
            <td class="col-context">
              {#if log.context}
                <span class="context-tag">{log.context}</span>
              {/if}
            </td>
            <td class="col-message">
              <span class="message">{log.message}</span>
            </td>
          </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  {#if total > 100}
  <div class="pagination">
    <button onclick={() => { page = Math.max(1, page - 1); loadLogs(); }} disabled={page === 1}>Prev</button>
    <span>Page {page} of {Math.ceil(total / 100)}</span>
    <button onclick={() => { page++; loadLogs(); }} disabled={page * 100 >= total}>Next</button>
  </div>
  {/if}
</div>

<style>
  .logs-page {
    max-width: 1400px;
    margin: 0 auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    color: #f1f5f9;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .auto-refresh {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #94a3b8;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn {
    padding: 0.4rem 1rem;
    background: #334155;
    border: 1px solid #475569;
    border-radius: 6px;
    color: #e2e8f0;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .btn:hover {
    background: #475569;
  }

  .stats-bar {
    display: flex;
    gap: 1.5rem;
    padding: 1rem 1.5rem;
    background: #1e293b;
    border-radius: 8px;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
  }

  .stat-value {
    font-size: 1.1rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .stat-label {
    font-size: 0.7rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .filters {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
    align-items: center;
  }

  .filters input,
  .filters select {
    padding: 0.5rem 0.75rem;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 0.85rem;
  }

  .filters input {
    flex: 1;
    min-width: 200px;
  }

  .result-count {
    color: #64748b;
    font-size: 0.8rem;
    white-space: nowrap;
  }

  .log-table {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 8px;
    overflow: hidden;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
  }

  thead {
    background: #1e293b;
  }

  th {
    padding: 0.6rem 0.75rem;
    text-align: left;
    color: #64748b;
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  td {
    padding: 0.4rem 0.75rem;
    border-top: 1px solid #1e293b;
    vertical-align: top;
  }

  .col-time { width: 110px; }
  .col-level { width: 70px; }
  .col-context { width: 120px; }

  .date {
    color: #475569;
    font-size: 0.7rem;
    margin-right: 0.3rem;
  }

  .time {
    color: #94a3b8;
  }

  .level-badge {
    font-weight: 600;
    font-size: 0.75rem;
  }

  .context-tag {
    background: #1e293b;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    color: #94a3b8;
    font-size: 0.75rem;
  }

  .message {
    color: #cbd5e1;
    word-break: break-word;
  }

  .level-error td, .level-fatal td {
    background: rgba(239, 68, 68, 0.05);
  }

  .level-warn td {
    background: rgba(251, 191, 36, 0.03);
  }

  .loading, .empty {
    padding: 3rem;
    text-align: center;
    color: #64748b;
  }

  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 1rem;
    margin-top: 1rem;
    color: #94a3b8;
    font-size: 0.85rem;
  }

  .pagination button {
    padding: 0.4rem 1rem;
    background: #334155;
    border: 1px solid #475569;
    border-radius: 6px;
    color: #e2e8f0;
    cursor: pointer;
  }

  .pagination button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
