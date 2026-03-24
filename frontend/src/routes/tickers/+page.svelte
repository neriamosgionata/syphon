<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { onSSE } from '$lib/sse';

  let tickers: any = $state(null);
  let loading = $state(true);
  let searchQuery = $state('');
  let searchResults: any[] = $state([]);
  let searching = $state(false);
  let addingSymbol = $state('');

  // Filters
  let filterSearch = $state('');
  let sectorFilter = $state('');
  let exchangeFilter = $state('');
  let sentimentFilter = $state('');
  let sortBy = $state('symbol');
  let sortDir = $state('asc');
  let sectors: string[] = $state([]);
  let exchanges: string[] = $state([]);

  async function load() {
    loading = true;
    try {
      const params: Record<string, string> = { limit: '50' };
      if (filterSearch) params.search = filterSearch;
      if (sectorFilter) params.sector = sectorFilter;
      if (exchangeFilter) params.exchange = exchangeFilter;
      if (sentimentFilter) params.sentiment = sentimentFilter;
      if (sortBy !== 'symbol') params.sort = sortBy;
      if (sortDir !== 'asc') params.dir = sortDir;
      tickers = await api.tickers(params);
      if (tickers.filters) {
        sectors = tickers.filters.sectors || [];
        exchanges = tickers.filters.exchanges || [];
      }
    } catch {}
    loading = false;
  }

  function applyFilters() {
    load();
  }

  function toggleSort(col: string) {
    if (sortBy === col) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = col;
      sortDir = col === 'symbol' || col === 'name' ? 'asc' : 'desc';
    }
    load();
  }

  function clearFilters() {
    filterSearch = '';
    sectorFilter = '';
    exchangeFilter = '';
    sentimentFilter = '';
    sortBy = 'symbol';
    sortDir = 'asc';
    load();
  }

  let hasActiveFilters = $derived(
    filterSearch || sectorFilter || exchangeFilter || sentimentFilter || sortBy !== 'symbol'
  );

  let searchTimeout: ReturnType<typeof setTimeout>;
  function handleSearch() {
    clearTimeout(searchTimeout);
    if (searchQuery.length < 1) {
      searchResults = [];
      return;
    }
    searchTimeout = setTimeout(async () => {
      searching = true;
      searchResults = await api.searchTickers(searchQuery).catch(() => []);
      searching = false;
    }, 300);
  }

  async function addTicker(symbol: string) {
    addingSymbol = symbol;
    await api.addTicker(symbol).catch(() => {});
    addingSymbol = '';
    searchQuery = '';
    searchResults = [];
    setTimeout(load, 3000);
  }

  async function refreshTicker(symbol: string) {
    await api.refreshTicker(symbol).catch(() => {});
  }

  onMount(() => {
    load();
    return onSSE('ticker_match', () => load());
  });
</script>

<svelte:head>
  <title>Tickers - Syphon</title>
</svelte:head>

<div class="page">
  <h1 style="margin-bottom: 1.5rem;">Tickers</h1>

  <div class="card" style="margin-bottom: 1.5rem;">
    <h3 style="margin-bottom: 0.75rem;">Add Ticker</h3>
    <div class="search-box">
      <input
        type="text"
        placeholder="Search for a ticker (e.g. AAPL, Tesla, MSFT)..."
        bind:value={searchQuery}
        oninput={handleSearch}
      />
    </div>
    {#if searchResults.length > 0}
      <div class="search-results">
        {#each searchResults as r}
          <div class="search-item">
            <div>
              <strong>{r.symbol}</strong>
              <span class="result-name">{r.name}</span>
              {#if r.exchange}
                <span class="result-exchange">{r.exchange}</span>
              {/if}
            </div>
            <button
              class="btn btn-primary"
              disabled={addingSymbol === r.symbol}
              onclick={() => addTicker(r.symbol)}
            >
              {addingSymbol === r.symbol ? 'Adding...' : 'Add'}
            </button>
          </div>
        {/each}
      </div>
    {:else if searching}
      <div class="loading" style="padding: 1rem;">Searching...</div>
    {/if}
  </div>

  <!-- Filters -->
  <div class="card filter-card" style="margin-bottom: 1.5rem;">
    <div class="filter-row">
      <input
        type="text"
        placeholder="Filter by name or symbol..."
        bind:value={filterSearch}
        onkeydown={(e) => e.key === 'Enter' && applyFilters()}
      />
      <select bind:value={sentimentFilter} onchange={applyFilters}>
        <option value="">All sentiments</option>
        <option value="bullish">Bullish (avg &gt; 0)</option>
        <option value="bearish">Bearish (avg &lt; 0)</option>
        <option value="neutral">Neutral (avg = 0)</option>
      </select>
      <select bind:value={sectorFilter} onchange={applyFilters}>
        <option value="">All sectors</option>
        {#each sectors as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
      <select bind:value={exchangeFilter} onchange={applyFilters}>
        <option value="">All exchanges</option>
        {#each exchanges as e}
          <option value={e}>{e}</option>
        {/each}
      </select>
      {#if hasActiveFilters}
        <button class="btn clear-btn" onclick={clearFilters}>Clear</button>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading tickers...</div>
  {:else if tickers?.data?.length > 0}
    <div class="card">
      <table>
        <thead>
          <tr>
            <th class="sortable" onclick={() => toggleSort('symbol')}>
              Symbol {sortBy === 'symbol' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th class="sortable" onclick={() => toggleSort('name')}>
              Name {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th>Exchange</th>
            <th>Sector</th>
            <th class="sortable" onclick={() => toggleSort('current_price')}>
              Price {sortBy === 'current_price' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th class="sortable" onclick={() => toggleSort('market_cap')}>
              Market Cap {sortBy === 'market_cap' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th>Last Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each tickers.data as t}
            <tr>
              <td>
                <a href="/tickers/{t.symbol}"><strong>{t.symbol}</strong></a>
              </td>
              <td>{t.name}</td>
              <td>{t.exchange || '-'}</td>
              <td>{t.sector || '-'}</td>
              <td class="num">{t.current_price != null || t.currentPrice != null ? `$${Number(t.current_price ?? t.currentPrice).toFixed(2)}` : '-'}</td>
              <td class="num">
                {#if t.market_cap ?? t.marketCap}
                  ${(Number(t.market_cap ?? t.marketCap) / 1e9).toFixed(1)}B
                {:else}
                  -
                {/if}
              </td>
              <td class="time">
                {t.last_fetched_at || t.lastFetchedAt ? new Date(t.last_fetched_at || t.lastFetchedAt).toLocaleString() : 'Never'}
              </td>
              <td>
                <button class="btn" onclick={() => refreshTicker(t.symbol)}>Refresh</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="empty card">
      {#if hasActiveFilters}
        No tickers match your filters. <button class="btn" onclick={clearFilters}>Clear filters</button>
      {:else}
        No tickers tracked yet. Search and add tickers above.
      {/if}
    </div>
  {/if}
</div>

<style>
  .search-box input {
    width: 100%;
  }
  .search-results {
    margin-top: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 300px;
    overflow-y: auto;
  }
  .search-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }
  .search-item:last-child { border-bottom: none; }
  .result-name {
    color: var(--text-muted);
    margin-left: 0.5rem;
  }
  .result-exchange {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-left: 0.5rem;
  }
  .filter-card {
    padding: 1rem 1.25rem;
  }
  .filter-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .filter-row input {
    flex: 1;
    min-width: 180px;
  }
  .clear-btn {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .sortable {
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .sortable:hover {
    color: var(--accent);
  }
  .num {
    font-family: 'SF Mono', monospace;
    font-size: 0.9rem;
  }
  .time {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
</style>
