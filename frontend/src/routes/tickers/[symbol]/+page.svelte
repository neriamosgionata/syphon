<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api';
  import { onSSE } from '$lib/sse';
  import StatCard from '$lib/components/StatCard.svelte';
  import TickerChart from '$lib/components/TickerChart.svelte';
  import NewsTable from '$lib/components/NewsTable.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';
  import OrderEntry from '$lib/components/OrderEntry.svelte';

  let data: any = $state(null);
  let loading = $state(true);
  let timeline: any[] = $state([]);
  let showTradePanel = $state(false);
  let tradeOrders: any = $state(null);
  let analysisSentimentFilter = $state('');

  async function loadData() {
    const symbol = $page.params.symbol!;
    try {
      const [tickerData, timelineData] = await Promise.all([
        api.ticker(symbol),
        api.analysisTimeline(symbol, 90).catch(() => []),
      ]);
      data = tickerData;
      timeline = timelineData || [];
      tradeOrders = await api.tradingOrders({ symbol, limit: '10' }).catch(() => ({ data: [] }));
    } catch {}
    loading = false;
  }

  onMount(() => {
    loadData();
    const symbol = $page.params.symbol!;
    const unsub1 = onSSE('ticker_match', (d: any) => {
      if (d.ticker?.symbol === symbol) loadData();
    });
    const unsub2 = onSSE('order_update', (d: any) => {
      if (d.symbol === symbol) loadData();
    });
    return () => { unsub1(); unsub2(); };
  });

  let filteredAnalyses = $derived(
    (data?.analyses || []).filter((a: any) => {
      if (!analysisSentimentFilter) return true;
      return a.sentiment === analysisSentimentFilter;
    })
  );
</script>

<svelte:head>
  <title>{$page.params.symbol} - Syphon</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading...</div>
{:else if data}
  <div class="page">
    <a href="/tickers" style="color: var(--text-muted); font-size: 0.85rem;">Back to tickers</a>

    <div class="ticker-header">
      <div>
        <h1>{data.ticker.symbol}</h1>
        <span class="ticker-name">{data.ticker.name}</span>
      </div>
      {#if data.ticker.current_price ?? data.ticker.currentPrice}
        <div class="price">
          ${Number(data.ticker.current_price ?? data.ticker.currentPrice).toFixed(2)}
        </div>
      {/if}
    </div>

    <div class="grid grid-4" style="margin-bottom: 1.5rem;">
      <StatCard label="Exchange" value={data.ticker.exchange || '-'} />
      <StatCard label="Sector" value={data.ticker.sector || '-'} />
      <StatCard
        label="Market Cap"
        value={data.ticker.market_cap ?? data.ticker.marketCap
          ? `$${(Number(data.ticker.market_cap ?? data.ticker.marketCap) / 1e9).toFixed(1)}B`
          : '-'}
      />
      <StatCard label="Analyses" value={data.analyses?.length || 0} />
    </div>

    <!-- Trade Panel -->
    <div class="trade-section" style="margin-bottom: 1.5rem;">
      <button class="btn btn-primary trade-toggle" onclick={() => showTradePanel = !showTradePanel}>
        {showTradePanel ? 'Hide' : 'Trade'} {data.ticker.symbol}
      </button>

      {#if showTradePanel}
        <div class="grid grid-2" style="margin-top: 1rem;">
          <div class="card">
            <OrderEntry
              symbol={data.ticker.symbol}
              currentPrice={data.ticker.current_price ?? data.ticker.currentPrice}
              onOrderPlaced={() => {
                api.tradingOrders({ symbol: data.ticker.symbol, limit: '10' })
                  .then((o) => tradeOrders = o)
                  .catch(() => {});
              }}
            />
          </div>

          <div class="card">
            <h3 style="margin-bottom: 1rem;">Recent Orders for {data.ticker.symbol}</h3>
            {#if tradeOrders?.data?.length > 0}
              <div class="mini-orders">
                {#each tradeOrders.data as t}
                  <div class="mini-order">
                    <div class="mini-order-main">
                      <span class="side-label" class:buy={t.side === 'BUY'} class:sell={t.side === 'SELL'}>
                        {t.side}
                      </span>
                      <span>{t.quantity} @ {t.fill_price ?? t.fillPrice ? `$${(t.fill_price ?? t.fillPrice).toFixed(2)}` : (t.order_type ?? t.orderType)}</span>
                      <span class="order-status" style="color: {t.status === 'filled' ? 'var(--green)' : t.status === 'error' ? 'var(--red)' : 'var(--text-muted)'}">
                        {t.status}
                      </span>
                    </div>
                    <span class="order-time">{new Date(t.created_at ?? t.createdAt).toLocaleString()}</span>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="empty">No orders for this ticker yet</div>
            {/if}
            <a href="/trading" class="btn" style="margin-top: 1rem; display: inline-block;">View All Orders</a>
          </div>
        </div>
      {/if}
    </div>

    {#if data.ticker.snapshots?.length > 0}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">Price History & Sentiment</h3>
        <TickerChart
          snapshots={data.ticker.snapshots}
          sentimentData={timeline}
          label="{data.ticker.symbol} Price"
        />
      </div>
    {/if}

    {#if data.sentimentSummary?.length > 0}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">Sentiment Summary</h3>
        <div class="sentiment-grid">
          {#each data.sentimentSummary as s}
            <div class="sentiment-item">
              <SentimentBadge sentiment={s.sentiment} />
              <span class="count">{s.count} articles</span>
              <span class="avg">avg: {Number(s.avg_score).toFixed(3)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if data.analyses?.length > 0}
      <div class="card">
        <div class="analyses-header">
          <h3>Recent Analyses</h3>
          <select bind:value={analysisSentimentFilter} class="sentiment-select">
            <option value="">All sentiments</option>
            <option value="very_bullish">Very Bullish</option>
            <option value="bullish">Bullish</option>
            <option value="neutral">Neutral</option>
            <option value="bearish">Bearish</option>
            <option value="very_bearish">Very Bearish</option>
          </select>
        </div>
        {#if filteredAnalyses.length > 0}
          <NewsTable analyses={filteredAnalyses} />
        {:else}
          <div class="empty">No analyses match the selected sentiment.</div>
        {/if}
      </div>
    {:else}
      <div class="empty card">No analyses yet for this ticker.</div>
    {/if}
  </div>
{:else}
  <div class="empty card">Ticker not found</div>
{/if}

<style>
  .ticker-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin: 1rem 0 1.5rem;
  }
  .ticker-name {
    color: var(--text-muted);
    font-size: 1rem;
  }
  .price {
    font-size: 2.5rem;
    font-weight: 800;
    font-family: 'SF Mono', monospace;
  }
  .sentiment-grid {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }
  .sentiment-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .count {
    font-weight: 600;
  }
  .avg {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .trade-toggle {
    font-size: 1rem;
    padding: 0.6rem 1.5rem;
  }
  .mini-orders {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mini-order {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .mini-order:last-child { border-bottom: none; }
  .mini-order-main {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.9rem;
  }
  .side-label { font-weight: 700; font-size: 0.8rem; }
  .side-label.buy { color: var(--green); }
  .side-label.sell { color: var(--red); }
  .order-status {
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: capitalize;
    margin-left: auto;
  }
  .order-time {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .analyses-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .sentiment-select {
    font-size: 0.85rem;
  }
</style>
