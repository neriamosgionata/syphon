<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { onSSE } from '$lib/sse';
  import StatCard from '$lib/components/StatCard.svelte';
  import NewsTable from '$lib/components/NewsTable.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';

  let dashboard: any = $state(null);
  let loading = $state(true);
  let error = $state('');
  let sentimentFilter = $state('');
  let activeJobs: any[] = $state([]);
  let failedJobs: any[] = $state([]);
  let showFailedJobs = $state(false);

  async function load() {
    try {
      dashboard = await api.dashboard();
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function loadJobs() {
    try {
      const data = await api.activeJobs();
      activeJobs = data.jobs || [];
    } catch {
      activeJobs = [];
    }
  }

  async function loadFailedJobs() {
    try {
      const data = await api.failedJobs(50);
      failedJobs = data.jobs || [];
    } catch {
      failedJobs = [];
    }
  }

  async function retryJob(queue: string, id: string) {
    await api.retryJob(queue, id).catch(() => {});
    setTimeout(() => { loadFailedJobs(); loadJobs(); }, 1000);
  }

  async function removeJob(queue: string, id: string) {
    await api.removeFailedJob(queue, id).catch(() => {});
    failedJobs = failedJobs.filter((j) => !(j.queue === queue && j.id === id));
  }

  async function cancelJob(queue: string, id: string) {
    await api.cancelJob(queue, id).catch(() => {});
    activeJobs = activeJobs.filter((j) => !(j.queue === queue && j.id === id));
    setTimeout(() => { loadJobs(); loadFailedJobs(); }, 500);
  }

  async function cancelAllJobs() {
    await api.drainQueues().catch(() => {});
    activeJobs = [];
    setTimeout(() => { load(); loadJobs(); }, 500);
  }

  function timeAgo(ts: number | null): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  let draining = $state(false);
  let drainMsg = $state('');

  async function drainQueues() {
    draining = true;
    drainMsg = '';
    try {
      const res = await api.drainQueues();
      drainMsg = res.message || 'All queues drained';
      await load();
      await loadJobs();
    } catch {
      drainMsg = 'Failed to drain queues';
    } finally {
      draining = false;
      setTimeout(() => drainMsg = '', 4000);
    }
  }

  let pruning = $state(false);
  let showPruneConfirm = $state(false);

  async function pruneDatabase() {
    pruning = true;
    try {
      await api.pruneDatabase();
      showPruneConfirm = false;
      await load();
      await loadJobs();
      await loadFailedJobs();
    } catch (e: any) {
      error = e.message;
    } finally {
      pruning = false;
    }
  }

  async function refreshTickers() {
    await api.refreshAllTickers();
    setTimeout(loadJobs, 500);
  }

  async function triggerScrape() {
    await api.triggerScrape();
    setTimeout(loadJobs, 500);
  }

  async function triggerAnalysis() {
    await api.triggerAnalysis(100);
    setTimeout(loadJobs, 500);
  }

  function toggleSentiment(sentiment: string) {
    sentimentFilter = sentimentFilter === sentiment ? '' : sentiment;
  }

  onMount(() => {
    load();
    loadJobs();
    loadFailedJobs();

    const unsub1 = onSSE('ticker_match', () => load());
    const unsub2 = onSSE('scrape_complete', () => { load(); loadJobs(); });
    const unsub3 = onSSE('job_progress', (data: any) => {
      activeJobs = activeJobs.map((j) =>
        j.id === data.jobId && j.queue === data.queue
          ? { ...j, progress: data.progress, stage: data.stage, detail: data.detail, state: 'active' }
          : j
      );
    });
    const unsub4 = onSSE('job_finished', (data: any) => {
      // Remove finished job after a brief delay so user sees 100%
      activeJobs = activeJobs.map((j) =>
        j.id === data.jobId && j.queue === data.queue
          ? { ...j, progress: 100, stage: data.status === 'completed' ? 'Done' : 'Failed', state: data.status, detail: data.error || '' }
          : j
      );
      setTimeout(() => {
        activeJobs = activeJobs.filter((j) => !(j.id === data.jobId && j.queue === data.queue && (j.state === 'completed' || j.state === 'failed')));
        load();
        if (data.status === 'failed') loadFailedJobs();
      }, 2000);
    });

    // Poll active jobs periodically to catch new jobs
    const jobPoll = setInterval(loadJobs, 4000);

    return () => {
      unsub1(); unsub2(); unsub3(); unsub4();
      clearInterval(jobPoll);
    };
  });

  function sentimentMatchesAvg(avgSentiment: number, filter: string): boolean {
    if (filter === 'very_bullish') return avgSentiment >= 0.3;
    if (filter === 'bullish') return avgSentiment > 0 && avgSentiment < 0.3;
    if (filter === 'neutral') return avgSentiment === 0;
    if (filter === 'bearish') return avgSentiment < 0 && avgSentiment > -0.3;
    if (filter === 'very_bearish') return avgSentiment <= -0.3;
    return true;
  }

  let filteredTopTickers = $derived(
    (dashboard?.topTickers || []).filter((t: any) => {
      if (!sentimentFilter) return true;
      return sentimentMatchesAvg(Number(t.avg_sentiment), sentimentFilter);
    })
  );

  let filteredRecentAnalyses = $derived(
    (dashboard?.recentAnalyses || []).filter((a: any) => {
      if (!sentimentFilter) return true;
      return a.sentiment === sentimentFilter;
    }).slice(0, 15)
  );

  const QUEUE_LABELS: Record<string, string> = {
    'scrape-news': 'Scrape News',
    'analyze-article': 'Analyze Article',
    'fetch-ticker': 'Fetch Ticker',
    'submit-order': 'Submit Order',
    'monitor-order': 'Monitor Order',
  };

  function queueLabel(name: string) {
    return QUEUE_LABELS[name] || name;
  }

  function stateColor(state: string) {
    if (state === 'active') return 'var(--accent)';
    if (state === 'completed') return 'var(--green)';
    if (state === 'failed') return 'var(--red)';
    return 'var(--text-muted)';
  }

  function jobDescription(job: any): string {
    const d = job.data || {};
    if (job.queue === 'scrape-news') return d.sourceId ? `Source #${d.sourceId}` : 'All sources';
    if (job.queue === 'analyze-article') return `Article #${d.articleId || '?'}`;
    if (job.queue === 'fetch-ticker') return d.symbols ? `${d.symbols.length} tickers` : d.symbol || '?';
    if (job.queue === 'submit-order') return `Trade #${d.tradeId || '?'}`;
    if (job.queue === 'monitor-order') return `Trade #${d.tradeId || '?'}`;
    return '';
  }
</script>

<svelte:head>
  <title>Dashboard - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>Dashboard</h1>
    <div class="actions">
      {#if sentimentFilter}
        <button class="btn active-filter-btn" onclick={() => sentimentFilter = ''}>
          Filtering: <strong>{sentimentFilter.replace('_', ' ')}</strong> &times;
        </button>
      {/if}
      {#if drainMsg}
        <span style="font-size: 0.85rem; color: var(--accent);">{drainMsg}</span>
      {/if}
      <button class="btn" onclick={refreshTickers}>Refresh Tickers</button>
      <button class="btn" onclick={triggerScrape}>Scrape News</button>
      <button class="btn btn-primary" onclick={triggerAnalysis}>Run Analysis</button>
      <button class="btn btn-warning" onclick={drainQueues} disabled={draining}>
        {draining ? 'Draining...' : 'Drain Queues'}
      </button>
      <button class="btn btn-danger" onclick={() => showPruneConfirm = true}>Prune DB</button>
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading dashboard...</div>
  {:else if error}
    <div class="card" style="color: var(--red);">Error: {error}</div>
  {:else if dashboard}
    <div class="grid grid-4" style="margin-bottom: 1.5rem;">
      <StatCard label="Total Articles" value={dashboard.stats.totalArticles.toLocaleString()} />
      <StatCard label="Active Tickers" value={dashboard.stats.totalTickers} />
      <StatCard label="Analyses Made" value={dashboard.stats.totalAnalyses.toLocaleString()} />
      <StatCard label="Pending Analysis" value={dashboard.stats.unanalyzedArticles} />
    </div>

    <div class="grid grid-2" style="margin-bottom: 1.5rem;">
      <div class="card">
        <div class="section-header">
          <h3>Sentiment Distribution</h3>
          {#if sentimentFilter}
            <button class="clear-link" onclick={() => sentimentFilter = ''}>Clear filter</button>
          {:else}
            <span class="hint">Click to filter</span>
          {/if}
        </div>
        {#if dashboard.sentimentDistribution?.length > 0}
          <div class="sentiment-bars">
            {#each dashboard.sentimentDistribution as item}
              <button
                class="sentiment-row"
                class:selected={sentimentFilter === item.sentiment}
                class:dimmed={sentimentFilter && sentimentFilter !== item.sentiment}
                onclick={() => toggleSentiment(item.sentiment)}
              >
                <SentimentBadge sentiment={item.sentiment} />
                <div class="bar-track">
                  <div
                    class="bar-fill {item.sentiment}"
                    style="width: {Math.max(2, (item.count / dashboard.stats.totalAnalyses) * 100)}%"
                  ></div>
                </div>
                <span class="bar-count">{item.count}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="empty">No data yet</div>
        {/if}
      </div>

      <div class="card queue-status-card">
        <h3 style="margin-bottom: 1rem;">Queue Status</h3>
        {#if dashboard.queues && Object.keys(dashboard.queues).length > 0}
          <div class="table-scroll">
            <table>
              <thead>
                <tr><th>Queue</th><th>Active</th><th>Waiting</th><th>Completed</th><th>Failed</th></tr>
              </thead>
              <tbody>
                {#each Object.entries(dashboard.queues) as [name, stats]}
                  <tr>
                    <td><strong>{queueLabel(name)}</strong></td>
                    <td>{(stats as any).active}</td>
                    <td>{(stats as any).waiting}</td>
                    <td>{(stats as any).completed}</td>
                    <td style="color: {(stats as any).failed > 0 ? 'var(--red)' : 'inherit'}">{(stats as any).failed}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty">No queue data available</div>
        {/if}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3 style="margin-bottom: 1rem;">
          Top Tickers
          {#if sentimentFilter}
            <span class="filter-tag">{sentimentFilter.replace('_', ' ')}</span>
          {/if}
        </h3>
        {#if filteredTopTickers.length > 0}
          <table>
            <thead>
              <tr><th>Symbol</th><th>Name</th><th>Price</th><th>Analyses</th><th>Avg Sentiment</th></tr>
            </thead>
            <tbody>
              {#each filteredTopTickers as t}
                <tr>
                  <td><a href="/tickers/{t.symbol}"><strong>{t.symbol}</strong></a></td>
                  <td>{t.name}</td>
                  <td>${t.current_price != null ? Number(t.current_price).toFixed(2) : '-'}</td>
                  <td>{t.analysis_count}</td>
                  <td class:positive={Number(t.avg_sentiment) > 0} class:negative={Number(t.avg_sentiment) < 0}>
                    {t.avg_sentiment != null ? Number(t.avg_sentiment).toFixed(3) : '-'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if dashboard.topTickers?.length > 0}
          <div class="empty">No tickers match the selected sentiment.</div>
        {:else}
          <div class="empty">No ticker data yet. <a href="/tickers">Add tickers</a></div>
        {/if}
      </div>

      <div class="card">
        <h3 style="margin-bottom: 1rem;">
          Recent Analyses
          {#if sentimentFilter}
            <span class="filter-tag">{sentimentFilter.replace('_', ' ')}</span>
          {/if}
        </h3>
        {#if filteredRecentAnalyses.length > 0}
          <NewsTable analyses={filteredRecentAnalyses} />
        {:else if (dashboard.recentAnalyses || []).length > 0}
          <div class="empty">No recent analyses match the selected sentiment.</div>
        {:else}
          <div class="empty">No analyses yet</div>
        {/if}
      </div>
    </div>
    <!-- Active Jobs -->
    {#if activeJobs.length > 0}
      <div class="jobs-section" style="margin-top: 1.5rem;">
        <div class="jobs-header">
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <h3>Active Jobs</h3>
            <span class="jobs-count">{activeJobs.length} running</span>
          </div>
          <button class="btn btn-sm btn-stop" onclick={cancelAllJobs}>Stop All</button>
        </div>
        <div class="jobs-grid">
          {#each activeJobs as job (job.queue + ':' + job.id)}
            <div class="job-card" class:job-active={job.state === 'active'} class:job-waiting={job.state === 'waiting'} class:job-done={job.state === 'completed'} class:job-failed={job.state === 'failed'}>
              <div class="job-top">
                <span class="job-queue">{queueLabel(job.queue)}</span>
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                  <span class="job-state" style="color: {stateColor(job.state)}">{job.state}</span>
                  <button class="job-cancel-btn" onclick={() => cancelJob(job.queue, job.id)} title="Cancel job">&times;</button>
                </div>
              </div>
              <div class="job-desc">{jobDescription(job)}</div>
              {#if job.stage}
                <div class="job-stage">{job.stage}{#if job.detail} &middot; {job.detail}{/if}</div>
              {/if}
              <div class="job-progress-track">
                <div
                  class="job-progress-fill"
                  class:fill-active={job.state === 'active'}
                  class:fill-done={job.state === 'completed'}
                  class:fill-failed={job.state === 'failed'}
                  style="width: {job.progress || 0}%"
                ></div>
              </div>
              <div class="job-percent">{job.progress || 0}%</div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Failed Jobs -->
    {#if failedJobs.length > 0}
      <div class="failed-section" style="margin-top: 1.5rem;">
        <div class="failed-header">
          <button class="failed-toggle" onclick={() => showFailedJobs = !showFailedJobs}>
            <span class="failed-icon">!</span>
            <h3>Failed Jobs</h3>
            <span class="failed-count">{failedJobs.length}</span>
            <span class="failed-chevron">{showFailedJobs ? '▾' : '▸'}</span>
          </button>
          {#if showFailedJobs}
            <div class="failed-actions">
              <button class="btn btn-sm" onclick={() => { failedJobs.forEach((j) => retryJob(j.queue, j.id)); }}>
                Retry All
              </button>
            </div>
          {/if}
        </div>
        {#if showFailedJobs}
          <div class="failed-list">
            {#each failedJobs as job (job.queue + ':' + job.id)}
              <div class="failed-card">
                <div class="failed-card-top">
                  <div class="failed-card-info">
                    <span class="failed-queue">{queueLabel(job.queue)}</span>
                    <span class="failed-job-desc">{jobDescription(job)}</span>
                  </div>
                  <span class="failed-time">{timeAgo(job.finishedOn || job.timestamp)}</span>
                </div>
                <div class="failed-reason">{job.failedReason}</div>
                {#if job.stacktrace?.length > 0}
                  <details class="failed-stacktrace">
                    <summary>Stack trace</summary>
                    <pre>{job.stacktrace.join('\n')}</pre>
                  </details>
                {/if}
                <div class="failed-card-meta">
                  <span class="failed-attempts">Attempts: {job.attemptsMade}/3</span>
                  <div class="failed-card-actions">
                    <button class="btn btn-sm" onclick={() => retryJob(job.queue, job.id)}>Retry</button>
                    <button class="btn btn-sm btn-dismiss" onclick={() => removeJob(job.queue, job.id)}>Dismiss</button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  {#if showPruneConfirm}
    <div class="modal-backdrop" onclick={() => showPruneConfirm = false}>
      <div class="modal" onclick={(e) => e.stopPropagation()}>
        <h3>Prune Database</h3>
        <p>This will permanently delete articles, analyses, trades, scrape sources, and search indexes. <strong>Tickers will be preserved.</strong></p>
        <p style="color: var(--red); font-weight: 600;">This action cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn" onclick={() => showPruneConfirm = false} disabled={pruning}>Cancel</button>
          <button class="btn btn-danger" onclick={pruneDatabase} disabled={pruning}>
            {pruning ? 'Pruning...' : 'Confirm Prune'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .active-filter-btn {
    border-color: var(--accent);
    color: var(--accent);
    font-size: 0.85rem;
  }

  /* Active Jobs Section */
  .jobs-section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .jobs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .jobs-count {
    font-size: 0.8rem;
    color: var(--accent);
    font-weight: 600;
  }
  .jobs-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }
  .job-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    transition: border-color 0.2s;
  }
  .job-card.job-active {
    border-color: var(--accent);
  }
  .job-card.job-done {
    border-color: var(--green);
    opacity: 0.7;
  }
  .job-card.job-failed {
    border-color: var(--red);
  }
  .job-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .job-queue {
    font-weight: 700;
    font-size: 0.85rem;
  }
  .job-state {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .job-desc {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .job-stage {
    font-size: 0.75rem;
    color: var(--text);
    font-weight: 500;
  }
  .job-progress-track {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 0.25rem;
  }
  .job-progress-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--text-muted);
    transition: width 0.3s ease;
  }
  .job-progress-fill.fill-active {
    background: var(--accent);
  }
  .job-progress-fill.fill-done {
    background: var(--green);
  }
  .job-progress-fill.fill-failed {
    background: var(--red);
  }
  .job-percent {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: 'SF Mono', monospace;
    text-align: right;
  }
  .job-cancel-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.3rem;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .job-cancel-btn:hover {
    color: var(--red);
    border-color: var(--red);
    background: rgba(239, 68, 68, 0.1);
  }
  .btn-stop {
    color: var(--red);
    border-color: var(--red);
  }
  .btn-stop:hover {
    background: rgba(239, 68, 68, 0.1);
  }

  /* Sentiment / Filters */
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-style: italic;
  }
  .clear-link {
    font-size: 0.8rem;
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .clear-link:hover {
    color: var(--text);
  }
  .sentiment-bars {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sentiment-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    transition: all 0.15s;
    width: 100%;
    text-align: left;
    color: inherit;
    font: inherit;
  }
  .sentiment-row:hover {
    background: var(--bg-hover);
    border-color: var(--border);
  }
  .sentiment-row.selected {
    background: var(--bg-hover);
    border-color: var(--accent);
  }
  .sentiment-row.dimmed {
    opacity: 0.4;
  }
  .sentiment-row.dimmed:hover {
    opacity: 0.7;
  }
  .bar-track {
    flex: 1;
    height: 8px;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s;
  }
  .bar-fill.very_bullish { background: var(--very-bullish); }
  .bar-fill.bullish { background: var(--bullish); }
  .bar-fill.neutral { background: var(--neutral); }
  .bar-fill.bearish { background: var(--bearish); }
  .bar-fill.very_bearish { background: var(--very-bearish); }
  .bar-count {
    font-size: 0.85rem;
    color: var(--text-muted);
    min-width: 40px;
    text-align: right;
  }
  .filter-tag {
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--accent);
    background: rgba(99, 102, 241, 0.1);
    padding: 0.15rem 0.5rem;
    border-radius: 20px;
    margin-left: 0.5rem;
    text-transform: capitalize;
    vertical-align: middle;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }

  /* Queue Status */
  .queue-status-card {
    min-width: 0;
  }
  .table-scroll {
    overflow-x: auto;
  }

  /* Failed Jobs Section */
  .failed-section {
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--red) 30%, var(--border));
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .failed-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .failed-toggle {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    font: inherit;
    padding: 0;
  }
  .failed-toggle:hover {
    opacity: 0.8;
  }
  .failed-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--red);
    color: white;
    font-size: 0.75rem;
    font-weight: 800;
    flex-shrink: 0;
  }
  .failed-count {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--red);
    background: rgba(239, 68, 68, 0.1);
    padding: 0.1rem 0.5rem;
    border-radius: 20px;
  }
  .failed-chevron {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .failed-actions {
    display: flex;
    gap: 0.5rem;
  }
  .btn-sm {
    font-size: 0.75rem;
    padding: 0.25rem 0.6rem;
  }
  .failed-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin-top: 1rem;
  }
  .failed-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-left: 3px solid var(--red);
    border-radius: var(--radius);
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .failed-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .failed-card-info {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .failed-queue {
    font-weight: 700;
    font-size: 0.85rem;
  }
  .failed-job-desc {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .failed-time {
    font-size: 0.7rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .failed-reason {
    font-size: 0.8rem;
    color: var(--red);
    font-family: 'SF Mono', monospace;
    word-break: break-word;
  }
  .failed-stacktrace {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .failed-stacktrace summary {
    cursor: pointer;
    user-select: none;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.3rem;
  }
  .failed-stacktrace pre {
    margin: 0;
    padding: 0.5rem;
    background: var(--bg-card);
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.7rem;
    line-height: 1.5;
    max-height: 150px;
    overflow-y: auto;
  }
  .failed-card-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.15rem;
  }
  .failed-attempts {
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .failed-card-actions {
    display: flex;
    gap: 0.35rem;
  }
  .btn-dismiss {
    color: var(--text-muted);
    border-color: var(--border);
  }
  .btn-dismiss:hover {
    color: var(--red);
    border-color: var(--red);
  }

  /* Warning button */
  .btn-warning {
    background: transparent;
    color: #f59e0b;
    border-color: #f59e0b;
  }
  .btn-warning:hover {
    background: rgba(245, 158, 11, 0.1);
  }
  .btn-warning:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Prune / Danger */
  :global(.btn-danger) {
    background: var(--red);
    color: white;
    border-color: var(--red);
  }
  :global(.btn-danger:hover) {
    opacity: 0.85;
  }
  :global(.btn-danger:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .modal {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    max-width: 420px;
    width: 90%;
  }
  .modal h3 {
    margin-bottom: 0.75rem;
  }
  .modal p {
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
    line-height: 1.5;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.25rem;
  }
</style>
