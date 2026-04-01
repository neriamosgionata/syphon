<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { onSSE } from '$lib/sse';
  import ArticleCard from '$lib/components/ArticleCard.svelte';

  let articles: any = $state(null);
  let loading = $state(true);
  let searchQuery = $state('');
  let selectedSource = $state('');
  let analyzedFilter = $state('');
  let sentimentFilter = $state('');
  let page = $state(1);
  let sources: any[] = $state([]);

  async function load() {
    loading = true;
    try {
      const params: Record<string, string> = { page: String(page), limit: '20' };
      if (selectedSource) params.source = selectedSource;
      if (analyzedFilter) params.analyzed = analyzedFilter;
      if (sentimentFilter) params.sentiment = sentimentFilter;
      articles = await api.articles(params);
    } catch {
      articles = { data: [] };
    } finally {
      loading = false;
    }
  }

  async function search() {
    if (!searchQuery.trim()) return load();
    loading = true;
    try {
      const results = await api.searchArticles({
        q: searchQuery,
        source: selectedSource || undefined,
      });
      articles = { data: results.articles, meta: { total: results.total } };
    } catch {
      articles = { data: [] };
    } finally {
      loading = false;
    }
  }

  let backfilling = $state(false);
  let backfillMsg = $state('');

  async function backfillNews() {
    backfilling = true;
    backfillMsg = '';
    try {
      const res = await api.backfillNews();
      backfillMsg = res.message || `Backfill queued for ${res.queued} tickers`;
    } catch {
      backfillMsg = 'Failed to start news backfill';
    }
    backfilling = false;
    setTimeout(() => backfillMsg = '', 5000);
  }

  onMount(() => {
    api.sources().catch(() => []).then((s) => sources = s);
    load();
    return onSSE('scrape_complete', () => load());
  });
</script>

<svelte:head>
  <title>Articles - Syphon</title>
</svelte:head>

<div class="page">
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
    <h1>Articles</h1>
    <div style="display: flex; align-items: center; gap: 0.75rem;">
      {#if backfillMsg}
        <span class="backfill-msg">{backfillMsg}</span>
      {/if}
      <button class="btn btn-primary" disabled={backfilling} onclick={backfillNews}>
        {backfilling ? 'Backfilling...' : 'Backfill History'}
      </button>
    </div>
  </div>

  <div class="filters card" style="margin-bottom: 1.5rem;">
    <div class="filter-row">
      <input
        type="text"
        placeholder="Search articles..."
        bind:value={searchQuery}
        onkeydown={(e) => e.key === 'Enter' && search()}
      />
      <select bind:value={selectedSource} onchange={load}>
        <option value="">All sources</option>
        {#each sources as s}
          <option value={s.name}>{s.name}</option>
        {/each}
      </select>
      <select bind:value={analyzedFilter} onchange={load}>
        <option value="">All</option>
        <option value="true">Analyzed</option>
        <option value="false">Pending</option>
      </select>
      <select bind:value={sentimentFilter} onchange={load}>
        <option value="">All sentiments</option>
        <option value="very_bullish">Very Bullish</option>
        <option value="bullish">Bullish</option>
        <option value="neutral">Neutral</option>
        <option value="bearish">Bearish</option>
        <option value="very_bearish">Very Bearish</option>
      </select>
      <button class="btn btn-primary" onclick={search}>Search</button>
    </div>
  </div>

  {#if loading && !articles}
    <div class="loading">Loading articles...</div>
  {:else if articles?.data?.length > 0}
    <div class="articles-grid">
      {#each articles.data as article}
        <ArticleCard {article} />
      {/each}
    </div>
    {#if articles.meta?.last_page > 1}
      <div class="pagination">
        <button class="btn" disabled={page <= 1} onclick={() => { page--; load(); }}>Prev</button>
        <span style="color: var(--text-muted); align-self: center;">
          Page {page} of {articles.meta.last_page}
        </span>
        <button class="btn" disabled={page >= articles.meta.last_page} onclick={() => { page++; load(); }}>Next</button>
      </div>
    {/if}
  {:else}
    <div class="empty card">No articles found. Try scraping some news from the dashboard.</div>
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
    min-width: 200px;
  }
  .articles-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  }
  .backfill-msg {
    font-size: 0.85rem;
    color: var(--accent);
  }
</style>
