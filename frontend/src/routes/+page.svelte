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

  async function load() {
    try {
      dashboard = await api.dashboard();
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function triggerScrape() {
    await api.triggerScrape();
  }

  async function triggerAnalysis() {
    await api.triggerAnalysis(100);
  }

  onMount(() => {
    load();
    const unsub1 = onSSE('ticker_match', () => load());
    const unsub2 = onSSE('scrape_complete', () => load());
    return () => { unsub1(); unsub2(); };
  });
</script>

<svelte:head>
  <title>Dashboard - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>Dashboard</h1>
    <div class="actions">
      <button class="btn" onclick={triggerScrape}>Scrape News</button>
      <button class="btn btn-primary" onclick={triggerAnalysis}>Run Analysis</button>
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
        <h3 style="margin-bottom: 1rem;">Sentiment Distribution</h3>
        {#if dashboard.sentimentDistribution?.length > 0}
          <div class="sentiment-bars">
            {#each dashboard.sentimentDistribution as item}
              <div class="sentiment-row">
                <SentimentBadge sentiment={item.sentiment} />
                <div class="bar-track">
                  <div
                    class="bar-fill {item.sentiment}"
                    style="width: {Math.max(2, (item.count / dashboard.stats.totalAnalyses) * 100)}%"
                  ></div>
                </div>
                <span class="bar-count">{item.count}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty">No data yet</div>
        {/if}
      </div>

      <div class="card">
        <h3 style="margin-bottom: 1rem;">Queue Status</h3>
        {#if dashboard.queues}
          <table>
            <thead>
              <tr><th>Queue</th><th>Active</th><th>Waiting</th><th>Completed</th><th>Failed</th></tr>
            </thead>
            <tbody>
              {#each Object.entries(dashboard.queues) as [name, stats]}
                <tr>
                  <td><strong>{name}</strong></td>
                  <td>{(stats as any).active}</td>
                  <td>{(stats as any).waiting}</td>
                  <td>{(stats as any).completed}</td>
                  <td style="color: {(stats as any).failed > 0 ? 'var(--red)' : 'inherit'}">{(stats as any).failed}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3 style="margin-bottom: 1rem;">Top Tickers</h3>
        {#if dashboard.topTickers?.length > 0}
          <table>
            <thead>
              <tr><th>Symbol</th><th>Name</th><th>Price</th><th>Analyses</th><th>Avg Sentiment</th></tr>
            </thead>
            <tbody>
              {#each dashboard.topTickers as t}
                <tr>
                  <td><a href="/tickers/{t.symbol}"><strong>{t.symbol}</strong></a></td>
                  <td>{t.name}</td>
                  <td>${t.current_price?.toFixed(2) || '-'}</td>
                  <td>{t.analysis_count}</td>
                  <td class:positive={Number(t.avg_sentiment) > 0} class:negative={Number(t.avg_sentiment) < 0}>
                    {t.avg_sentiment != null ? Number(t.avg_sentiment).toFixed(3) : '-'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div class="empty">No ticker data yet. <a href="/tickers">Add tickers</a></div>
        {/if}
      </div>

      <div class="card">
        <h3 style="margin-bottom: 1rem;">Recent Analyses</h3>
        <NewsTable analyses={dashboard.recentAnalyses || []} />
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
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .sentiment-bars {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .sentiment-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
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
  .positive { color: var(--green); }
  .negative { color: var(--red); }
</style>
