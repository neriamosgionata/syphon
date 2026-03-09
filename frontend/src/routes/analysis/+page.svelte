<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import NewsTable from '$lib/components/NewsTable.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';

  let stats: any = $state(null);
  let analyses: any = $state(null);
  let loading = $state(true);

  let tickerFilter = $state('');
  let sentimentFilter = $state('');
  let sortBy = $state('created_at');
  let page = $state(1);

  async function loadStats() {
    try {
      stats = await api.analysisStats();
    } catch {}
  }

  async function loadAnalyses() {
    loading = true;
    try {
      const params: Record<string, string> = {
        page: String(page),
        limit: '30',
        sort: sortBy,
        dir: 'desc',
      };
      if (tickerFilter) params.ticker = tickerFilter;
      if (sentimentFilter) params.sentiment = sentimentFilter;
      analyses = await api.analyses(params);
    } catch {
      analyses = { data: [] };
    }
    loading = false;
  }

  function applyFilters() {
    page = 1;
    loadAnalyses();
  }

  onMount(() => {
    loadStats();
    loadAnalyses();
  });
</script>

<svelte:head>
  <title>Analysis - Syphon</title>
</svelte:head>

<div class="page">
  <h1 style="margin-bottom: 1.5rem;">Analysis History</h1>

  {#if stats}
    <div class="grid grid-4" style="margin-bottom: 1.5rem;">
      <StatCard label="Total Analyses" value={stats.overall?.total || 0} />
      <StatCard
        label="Avg Sentiment"
        value={stats.overall?.avg_sentiment != null ? Number(stats.overall.avg_sentiment).toFixed(3) : '-'}
      />
      <StatCard label="Bullish" value={stats.overall?.bullish_count || 0} />
      <StatCard label="Bearish" value={stats.overall?.bearish_count || 0} />
    </div>

    {#if stats.byTicker?.length > 0}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">By Ticker</h3>
        <div class="ticker-chips">
          {#each stats.byTicker as t}
            <button
              class="ticker-chip"
              class:active={tickerFilter === t.symbol}
              onclick={() => { tickerFilter = tickerFilter === t.symbol ? '' : t.symbol; applyFilters(); }}
            >
              <strong>{t.symbol}</strong>
              <span class="chip-count">{t.analysis_count}</span>
              <span
                class="chip-sentiment"
                class:positive={t.avg_sentiment > 0}
                class:negative={t.avg_sentiment < 0}
              >
                {Number(t.avg_sentiment).toFixed(3)}
              </span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  <div class="card" style="margin-bottom: 1rem;">
    <div class="filter-row">
      <input
        type="text"
        placeholder="Filter by ticker..."
        bind:value={tickerFilter}
        onkeydown={(e) => e.key === 'Enter' && applyFilters()}
      />
      <select bind:value={sentimentFilter} onchange={applyFilters}>
        <option value="">All sentiments</option>
        <option value="very_bullish">Very Bullish</option>
        <option value="bullish">Bullish</option>
        <option value="neutral">Neutral</option>
        <option value="bearish">Bearish</option>
        <option value="very_bearish">Very Bearish</option>
      </select>
      <select bind:value={sortBy} onchange={applyFilters}>
        <option value="created_at">Newest</option>
        <option value="sentiment_score">Sentiment Score</option>
        <option value="relevance_score">Relevance</option>
        <option value="confidence">Confidence</option>
      </select>
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading analyses...</div>
  {:else}
    <div class="card">
      <NewsTable analyses={analyses?.data || []} />
    </div>
    {#if analyses?.meta?.last_page > 1}
      <div class="pagination">
        <button class="btn" disabled={page <= 1} onclick={() => { page--; loadAnalyses(); }}>Prev</button>
        <span style="color: var(--text-muted); align-self: center;">
          Page {page} of {analyses.meta.last_page}
        </span>
        <button class="btn" disabled={page >= analyses.meta.last_page} onclick={() => { page++; loadAnalyses(); }}>Next</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .filter-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .filter-row input {
    flex: 1;
    min-width: 180px;
  }
  .ticker-chips {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ticker-chip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.75rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.15s;
  }
  .ticker-chip:hover, .ticker-chip.active {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
  .chip-count {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .chip-sentiment {
    font-family: 'SF Mono', monospace;
    font-size: 0.8rem;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
</style>
