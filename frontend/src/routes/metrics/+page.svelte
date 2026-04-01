<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let metrics: any = $state(null);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    try {
      metrics = await api.metrics();
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function statusDot(status: string): string {
    if (status === 'ok') return 'dot-ok';
    if (status === 'not_configured') return 'dot-na';
    return 'dot-error';
  }

  function statusLabel(status: string): string {
    if (status === 'ok') return 'Healthy';
    if (status === 'not_configured') return 'N/A';
    if (status === 'degraded') return 'Degraded';
    return 'Error';
  }

  let sortedTables = $derived(
    (metrics?.database?.tables || [])
      .slice()
      .sort((a: any, b: any) => b.totalSize - a.totalSize)
  );

  let maxTableSize = $derived(
    sortedTables.length > 0 ? Math.max(...sortedTables.map((t: any) => t.totalSize)) : 1
  );

  onMount(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  });
</script>

<svelte:head>
  <title>Metrics - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>System Metrics</h1>
    <button class="btn" onclick={load}>Refresh</button>
  </div>

  {#if loading}
    <div class="loading">Loading metrics...</div>
  {:else if error}
    <div class="card" style="color: var(--red);">Error: {error}</div>
  {:else if metrics}
    <!-- Service Health -->
    <div class="card" style="margin-bottom: 1.5rem;">
      <h3 style="margin-bottom: 1rem;">Service Health</h3>
      <div class="health-grid">
        {#each Object.entries(metrics.services || {}) as [name, svc]}
          <div class="health-item">
            <span class="dot {statusDot((svc as any).status)}"></span>
            <div class="health-info">
              <span class="health-name">{name}</span>
              <span class="health-status">{statusLabel((svc as any).status)}</span>
              {#if (svc as any).latencyMs}
                <span class="health-latency">{(svc as any).latencyMs}ms</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>

    <div class="grid grid-3" style="margin-bottom: 1.5rem;">
      <!-- Process Memory -->
      <div class="card">
        <h3 style="margin-bottom: 1rem;">Process Memory</h3>
        <div class="mem-bar-label">
          <span>Heap Used</span>
          <span>{formatBytes(metrics.system.memory.heapUsed)} / {formatBytes(metrics.system.memory.heapTotal)}</span>
        </div>
        <div class="mem-bar-track">
          <div class="mem-bar-fill" style="width: {(metrics.system.memory.heapUsed / metrics.system.memory.heapTotal * 100).toFixed(1)}%"></div>
        </div>
        <div class="mem-details">
          <div class="mem-row">
            <span>RSS</span>
            <span>{formatBytes(metrics.system.memory.rss)}</span>
          </div>
          <div class="mem-row">
            <span>External</span>
            <span>{formatBytes(metrics.system.memory.external)}</span>
          </div>
          <div class="mem-row">
            <span>Array Buffers</span>
            <span>{formatBytes(metrics.system.memory.arrayBuffers)}</span>
          </div>
        </div>
      </div>

      <!-- Redis -->
      <div class="card">
        <h3 style="margin-bottom: 1rem;">Redis</h3>
        {#if metrics.redis.error}
          <div class="empty" style="color: var(--red);">{metrics.redis.error}</div>
        {:else}
          <div class="stat-rows">
            <div class="stat-row"><span>Memory</span><span>{metrics.redis.usedMemoryHuman || formatBytes(metrics.redis.usedMemory)}</span></div>
            <div class="stat-row"><span>Peak Memory</span><span>{formatBytes(metrics.redis.usedMemoryPeak)}</span></div>
            <div class="stat-row"><span>Keys</span><span>{metrics.redis.totalKeys.toLocaleString()}</span></div>
            <div class="stat-row"><span>Clients</span><span>{metrics.redis.connectedClients}</span></div>
            <div class="stat-row"><span>Uptime</span><span>{formatUptime(metrics.redis.uptimeSeconds)}</span></div>
            <div class="stat-row"><span>Version</span><span>{metrics.redis.version}</span></div>
          </div>
        {/if}
      </div>

      <!-- System -->
      <div class="card">
        <h3 style="margin-bottom: 1rem;">System</h3>
        <div class="stat-rows">
          <div class="stat-row"><span>Uptime</span><span>{formatUptime(metrics.system.uptime)}</span></div>
          <div class="stat-row"><span>Node</span><span>{metrics.system.nodeVersion}</span></div>
          <div class="stat-row"><span>Platform</span><span>{metrics.system.platform}</span></div>
          <div class="stat-row"><span>PID</span><span>{metrics.system.pid}</span></div>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom: 1.5rem;">
      <!-- Database Storage -->
      <div class="card">
        <h3 style="margin-bottom: 0.5rem;">Database Storage</h3>
        <div class="db-summary">
          <span>{formatBytes(metrics.database.totalSize)}</span>
          <span class="text-muted">{metrics.database.totalRows.toLocaleString()} rows</span>
        </div>
        <div class="table-bars">
          {#each sortedTables as table}
            <div class="table-bar-row">
              <span class="table-name">{table.name}</span>
              <div class="table-bar-track">
                <div class="table-bar-fill" style="width: {Math.max(2, (table.totalSize / maxTableSize) * 100)}%"></div>
              </div>
              <span class="table-meta">{table.rows.toLocaleString()} rows &middot; {formatBytes(table.totalSize)}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Queue Totals + Meilisearch -->
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">
        <div class="card">
          <h3 style="margin-bottom: 1rem;">Queue Totals</h3>
          <div class="queue-totals">
            <div class="qt-item">
              <span class="qt-value" style="color: var(--accent)">{metrics.queues.totals.active}</span>
              <span class="qt-label">Active</span>
            </div>
            <div class="qt-item">
              <span class="qt-value">{metrics.queues.totals.waiting}</span>
              <span class="qt-label">Waiting</span>
            </div>
            <div class="qt-item">
              <span class="qt-value" style="color: var(--green)">{metrics.queues.totals.completed}</span>
              <span class="qt-label">Completed</span>
            </div>
            <div class="qt-item">
              <span class="qt-value" style="color: var(--red)">{metrics.queues.totals.failed}</span>
              <span class="qt-label">Failed</span>
            </div>
          </div>
          {#if metrics.queues.queues}
            <div class="queue-breakdown">
              {#each Object.entries(metrics.queues.queues) as [name, stats]}
                <div class="qb-row">
                  <span class="qb-name">{name}</span>
                  <span class="qb-stats">
                    {#if (stats as any).active > 0}<span class="qb-active">{(stats as any).active} active</span>{/if}
                    {#if (stats as any).waiting > 0}<span class="qb-waiting">{(stats as any).waiting} waiting</span>{/if}
                    {#if (stats as any).failed > 0}<span class="qb-failed">{(stats as any).failed} failed</span>{/if}
                    {#if !(stats as any).active && !(stats as any).waiting && !(stats as any).failed}
                      <span class="text-muted">idle</span>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="card">
          <h3 style="margin-bottom: 1rem;">Meilisearch</h3>
          {#if metrics.meilisearch?.error}
            <div class="empty" style="color: var(--red);">{metrics.meilisearch.error}</div>
          {:else if !metrics.meilisearch?.indexes?.length}
            <div class="empty">No indexes</div>
          {:else}
            <div class="stat-rows">
              {#each metrics.meilisearch.indexes as idx}
                <div class="stat-row">
                  <span>{idx.name}</span>
                  <span>{idx.docs.toLocaleString()} docs{idx.isIndexing ? ' (indexing)' : ''}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Training API -->
    {#if metrics.services?.training?.modelLoaded !== undefined}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">Training API</h3>
        <div class="stat-rows">
          <div class="stat-row"><span>Status</span><span>{metrics.services.training.status}</span></div>
          <div class="stat-row"><span>Model Loaded</span><span>{metrics.services.training.modelLoaded ? 'Yes' : 'No'}</span></div>
          <div class="stat-row"><span>Latency</span><span>{metrics.services.training.latencyMs}ms</span></div>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  /* Health */
  .health-grid {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }
  .health-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-ok { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot-error { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .dot-na { background: var(--text-muted); opacity: 0.5; }
  .health-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .health-name {
    font-weight: 600;
    font-size: 0.9rem;
    text-transform: capitalize;
  }
  .health-status {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .health-latency {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: 'SF Mono', monospace;
  }

  /* Memory bar */
  .mem-bar-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    margin-bottom: 0.35rem;
  }
  .mem-bar-track {
    height: 8px;
    background: var(--border);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .mem-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 0.3s;
  }
  .mem-details {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .mem-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  /* Stat rows */
  .stat-rows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .stat-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .stat-row span:first-child {
    color: var(--text-muted);
  }

  /* Database */
  .db-summary {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    margin-bottom: 1rem;
    font-weight: 600;
  }
  .table-bars {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .table-bar-row {
    display: grid;
    grid-template-columns: 140px 1fr auto;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.8rem;
  }
  .table-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .table-bar-track {
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .table-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
  }
  .table-meta {
    font-size: 0.7rem;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 120px;
    text-align: right;
  }

  /* Queue Totals */
  .queue-totals {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1rem;
    text-align: center;
  }
  .qt-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .qt-value {
    font-size: 1.5rem;
    font-weight: 700;
    font-family: 'SF Mono', monospace;
  }
  .qt-label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .queue-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
  .qb-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
  }
  .qb-name {
    color: var(--text-muted);
  }
  .qb-stats {
    display: flex;
    gap: 0.5rem;
  }
  .qb-active { color: var(--accent); font-weight: 600; }
  .qb-waiting { color: var(--text-muted); }
  .qb-failed { color: var(--red); font-weight: 600; }
  .text-muted { color: var(--text-muted); }
</style>
