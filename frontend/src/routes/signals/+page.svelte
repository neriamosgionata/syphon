<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let data: any = $state(null);
  let loading = $state(true);
  let error = $state('');
  let days = $state('30');
  let minArticles = $state('0');
  let signalFilter = $state('');
  let sortBy = $state('composite');
  let sortDir = $state<'desc' | 'asc'>('desc');

  async function load() {
    loading = true;
    error = '';
    try {
      data = await api.signals({ days, min_articles: minArticles });
    } catch (e: any) {
      error = e.message;
    }
    loading = false;
  }

  let filteredSignals = $derived(() => {
    if (!data?.signals) return [];
    let list = data.signals;
    if (signalFilter) {
      list = list.filter((s: any) => s.signal === signalFilter);
    }
    list = [...list].sort((a: any, b: any) => {
      let va: number, vb: number;
      switch (sortBy) {
        case 'sentiment': va = a.breakdown.sentiment; vb = b.breakdown.sentiment; break;
        case 'momentum': va = a.breakdown.priceMomentum; vb = b.breakdown.priceMomentum; break;
        case 'rsi': va = a.breakdown.rsi; vb = b.breakdown.rsi; break;
        case 'news': va = a.meta.articleCount; vb = b.meta.articleCount; break;
        default: va = a.compositeScore; vb = b.compositeScore;
      }
      return sortDir === 'desc' ? vb - va : va - vb;
    });
    return list;
  });

  let signalCounts = $derived(() => {
    if (!data?.signals) return {};
    const counts: Record<string, number> = {};
    for (const s of data.signals) {
      counts[s.signal] = (counts[s.signal] || 0) + 1;
    }
    return counts;
  });

  function signalColor(signal: string): string {
    switch (signal) {
      case 'strong_buy': return 'var(--green)';
      case 'buy': return '#4ade80';
      case 'neutral': return 'var(--text-muted)';
      case 'sell': return '#f97316';
      case 'strong_sell': return 'var(--red)';
      default: return 'var(--text-muted)';
    }
  }

  function signalLabel(signal: string): string {
    return signal.replace('_', ' ').toUpperCase();
  }

  function scoreBarWidth(score: number): string {
    return Math.abs(score) + '%';
  }

  function toggleSort(col: string) {
    if (sortBy === col) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortBy = col;
      sortDir = 'desc';
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>Trading Signals - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>Trading Signals</h1>
    <div class="controls">
      <div class="control-group">
        <label for="days-select">Period</label>
        <select id="days-select" bind:value={days} onchange={load}>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
        </select>
      </div>
      <div class="control-group">
        <label for="min-articles">Min Articles</label>
        <select id="min-articles" bind:value={minArticles} onchange={load}>
          <option value="0">All</option>
          <option value="1">1+</option>
          <option value="3">3+</option>
          <option value="5">5+</option>
          <option value="10">10+</option>
        </select>
      </div>
      <div class="control-group">
        <label for="signal-filter">Signal</label>
        <select id="signal-filter" bind:value={signalFilter}>
          <option value="">All</option>
          <option value="strong_buy">Strong Buy</option>
          <option value="buy">Buy</option>
          <option value="neutral">Neutral</option>
          <option value="sell">Sell</option>
          <option value="strong_sell">Strong Sell</option>
        </select>
      </div>
      <button class="btn" onclick={load} disabled={loading}>
        {loading ? 'Loading...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  {#if loading && !data}
    <div class="loading">Generating trading signals...</div>
  {:else if data}
    <!-- Signal Summary -->
    <div class="signal-summary">
      {#each ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'] as sig}
        <button
          class="summary-chip"
          class:active={signalFilter === sig}
          style="--chip-color: {signalColor(sig)}"
          onclick={() => signalFilter = signalFilter === sig ? '' : sig}
        >
          <span class="chip-count">{signalCounts()[sig] || 0}</span>
          <span class="chip-label">{signalLabel(sig)}</span>
        </button>
      {/each}
      <div class="summary-meta">
        <span>{data.count} tickers analyzed</span>
        {#if data.generated_at}
          <span class="muted">Generated {new Date(data.generated_at).toLocaleTimeString()}</span>
        {/if}
      </div>
    </div>

    <!-- Signals Table -->
    <div class="card">
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th class="rank-col">#</th>
              <th>Ticker</th>
              <th class="sortable" onclick={() => toggleSort('composite')}>
                Score {sortBy === 'composite' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
              </th>
              <th>Signal</th>
              <th class="sortable" onclick={() => toggleSort('sentiment')}>
                Sentiment {sortBy === 'sentiment' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('momentum')}>
                Momentum {sortBy === 'momentum' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('rsi')}>
                RSI {sortBy === 'rsi' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('news')}>
                News {sortBy === 'news' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
              </th>
              <th>Price</th>
              <th>7d</th>
              <th>30d</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each filteredSignals() as signal, i}
              <tr class="signal-row">
                <td class="rank-col muted">{i + 1}</td>
                <td>
                  <a href="/tickers/{signal.symbol}" class="ticker-link">
                    <strong>{signal.symbol}</strong>
                    <span class="ticker-name">{signal.name}</span>
                  </a>
                </td>
                <td>
                  <div class="score-cell">
                    <span class="score-value" style="color: {signalColor(signal.signal)}">{signal.compositeScore}</span>
                    <div class="score-bar-bg">
                      <div
                        class="score-bar"
                        style="width: {scoreBarWidth(signal.compositeScore)}; background: {signalColor(signal.signal)}"
                      ></div>
                    </div>
                  </div>
                </td>
                <td>
                  <span class="signal-badge" style="color: {signalColor(signal.signal)}; border-color: {signalColor(signal.signal)}">
                    {signalLabel(signal.signal)}
                  </span>
                </td>
                <td>
                  <span class="breakdown-val" class:positive={signal.breakdown.sentiment > 0} class:negative={signal.breakdown.sentiment < 0}>
                    {signal.breakdown.sentiment > 0 ? '+' : ''}{signal.breakdown.sentiment}
                  </span>
                </td>
                <td>
                  <span class="breakdown-val" class:positive={signal.breakdown.priceMomentum > 0} class:negative={signal.breakdown.priceMomentum < 0}>
                    {signal.breakdown.priceMomentum > 0 ? '+' : ''}{signal.breakdown.priceMomentum}
                  </span>
                </td>
                <td>
                  <span class="breakdown-val" class:positive={signal.breakdown.rsi > 0} class:negative={signal.breakdown.rsi < 0}>
                    {signal.meta.rsiValue != null ? signal.meta.rsiValue : '-'}
                  </span>
                </td>
                <td>
                  <span class="news-count">{signal.meta.articleCount}</span>
                  {#if signal.meta.avgSentiment !== 0}
                    <span class="mini-sentiment" class:positive={signal.meta.avgSentiment > 0} class:negative={signal.meta.avgSentiment < 0}>
                      {signal.meta.avgSentiment > 0 ? '+' : ''}{signal.meta.avgSentiment}
                    </span>
                  {/if}
                </td>
                <td class="num">
                  {signal.currentPrice ? `$${signal.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-'}
                </td>
                <td class="num" class:positive={signal.meta.priceChange7d > 0} class:negative={signal.meta.priceChange7d < 0}>
                  {signal.meta.priceChange7d != null ? `${signal.meta.priceChange7d > 0 ? '+' : ''}${signal.meta.priceChange7d}%` : '-'}
                </td>
                <td class="num" class:positive={signal.meta.priceChange30d > 0} class:negative={signal.meta.priceChange30d < 0}>
                  {signal.meta.priceChange30d != null ? `${signal.meta.priceChange30d > 0 ? '+' : ''}${signal.meta.priceChange30d}%` : '-'}
                </td>
                <td>
                  <a href="/tickers/{signal.symbol}" class="btn btn-sm">View</a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if filteredSignals().length === 0}
        <div class="empty">No signals match the current filters.</div>
      {/if}
    </div>

    <!-- Breakdown Legend -->
    <div class="card legend-card">
      <h3 style="margin-bottom: 0.75rem;">Score Breakdown</h3>
      <div class="legend-grid">
        <div class="legend-item">
          <span class="legend-weight">20%</span>
          <span class="legend-label">Sentiment</span>
          <span class="legend-desc">Weighted avg news sentiment (relevance × confidence)</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">10%</span>
          <span class="legend-label">Sentiment Trend</span>
          <span class="legend-desc">Recent vs older sentiment direction</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">5%</span>
          <span class="legend-label">News Volume</span>
          <span class="legend-desc">Article count (more coverage = more attention)</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">20%</span>
          <span class="legend-label">Price Momentum</span>
          <span class="legend-desc">Recent vs older price trend from snapshots</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">10%</span>
          <span class="legend-label">RSI</span>
          <span class="legend-desc">Oversold (&lt;30) = buy, overbought (&gt;70) = sell</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">5%</span>
          <span class="legend-label">Volatility</span>
          <span class="legend-desc">Lower daily volatility = safer opportunity</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">10%</span>
          <span class="legend-label">Volume Trend</span>
          <span class="legend-desc">Increasing volume = stronger signal confirmation</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">10%</span>
          <span class="legend-label">52-Week Position</span>
          <span class="legend-desc">Near low = opportunity, near high = caution</span>
        </div>
        <div class="legend-item">
          <span class="legend-weight">10%</span>
          <span class="legend-label">Fundamentals</span>
          <span class="legend-desc">P/E ratio assessment (10-20 = value)</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .controls {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .control-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .control-group label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    font-weight: 600;
  }
  .error-banner {
    padding: 0.75rem 1rem;
    background: rgba(239, 68, 68, 0.15);
    color: var(--red);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius);
    margin-bottom: 1rem;
  }

  /* Signal Summary Chips */
  .signal-summary {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .summary-chip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card-bg);
    cursor: pointer;
    transition: all 0.15s;
    min-width: 70px;
  }
  .summary-chip:hover, .summary-chip.active {
    border-color: var(--chip-color);
    background: color-mix(in srgb, var(--chip-color) 10%, var(--card-bg));
  }
  .chip-count {
    font-size: 1.25rem;
    font-weight: 800;
    color: var(--chip-color);
    font-family: 'SF Mono', monospace;
  }
  .chip-label {
    font-size: 0.6rem;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--chip-color);
    letter-spacing: 0.03em;
  }
  .summary-meta {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.15rem;
    font-size: 0.8rem;
  }

  /* Table */
  .table-wrapper {
    overflow-x: auto;
  }
  th.sortable {
    cursor: pointer;
    user-select: none;
  }
  th.sortable:hover {
    color: var(--accent);
  }
  .rank-col {
    width: 40px;
    text-align: center;
  }
  .ticker-link {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    text-decoration: none;
    color: inherit;
  }
  .ticker-link:hover strong {
    color: var(--accent);
  }
  .ticker-name {
    font-size: 0.7rem;
    color: var(--text-muted);
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Score Bar */
  .score-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 100px;
  }
  .score-value {
    font-weight: 800;
    font-family: 'SF Mono', monospace;
    font-size: 0.95rem;
    min-width: 35px;
  }
  .score-bar-bg {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .score-bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s;
  }

  /* Signal Badge */
  .signal-badge {
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border: 1px solid;
    border-radius: 4px;
    white-space: nowrap;
  }

  /* Breakdown Values */
  .breakdown-val {
    font-family: 'SF Mono', monospace;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .num {
    font-family: 'SF Mono', monospace;
    font-size: 0.85rem;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .muted { color: var(--text-muted); }

  .news-count {
    font-weight: 700;
    font-size: 0.85rem;
  }
  .mini-sentiment {
    font-size: 0.7rem;
    font-family: 'SF Mono', monospace;
    margin-left: 0.25rem;
  }

  /* Legend */
  .legend-card {
    margin-top: 1.5rem;
  }
  .legend-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.5rem;
  }
  .legend-item {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.8rem;
    padding: 0.35rem 0;
  }
  .legend-weight {
    font-weight: 800;
    font-family: 'SF Mono', monospace;
    color: var(--accent);
    min-width: 30px;
  }
  .legend-label {
    font-weight: 700;
    min-width: 110px;
  }
  .legend-desc {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
</style>
