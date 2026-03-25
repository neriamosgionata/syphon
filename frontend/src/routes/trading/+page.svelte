<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { onSSE } from '$lib/sse';
  import StatCard from '$lib/components/StatCard.svelte';
  import OrderEntry from '$lib/components/OrderEntry.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';

  let status: any = $state(null);
  let stats: any = $state(null);
  let orders: any = $state(null);
  let loading = $state(true);
  let connectingIbkr = $state(false);
  let connectingKraken = $state(false);

  // Quick trade
  let quickSymbol = $state('');
  let activeBroker: 'ibkr' | 'kraken' = $state('ibkr');

  // Filters
  let statusFilter = $state('');
  let sideFilter = $state('');
  let symbolFilter = $state('');
  let page = $state(1);

  let ibkrConnected = $derived(status?.connection?.connected ?? false);
  let krakenConnected = $derived(status?.kraken?.connection?.connected ?? false);

  async function load() {
    loading = true;
    try {
      const [s, st, o] = await Promise.all([
        api.tradingStatus().catch(() => null),
        api.tradingStats().catch(() => null),
        loadOrders(),
      ]);
      status = s;
      stats = st;
    } catch {}
    loading = false;
  }

  async function loadOrders() {
    const params: Record<string, string> = { page: String(page), limit: '20' };
    if (statusFilter) params.status = statusFilter;
    if (sideFilter) params.side = sideFilter;
    if (symbolFilter) params.symbol = symbolFilter.toUpperCase();
    orders = await api.tradingOrders(params).catch(() => ({ data: [] }));
  }

  async function toggleIbkr() {
    connectingIbkr = true;
    try {
      if (ibkrConnected) {
        await api.tradingDisconnect('ibkr');
      } else {
        await api.tradingConnect('ibkr');
      }
      status = await api.tradingStatus().catch(() => null);
    } catch {}
    connectingIbkr = false;
  }

  async function toggleKraken() {
    connectingKraken = true;
    try {
      if (krakenConnected) {
        await api.tradingDisconnect('kraken');
      } else {
        await api.tradingConnect('kraken');
      }
      status = await api.tradingStatus().catch(() => null);
    } catch {}
    connectingKraken = false;
  }

  async function cancelOrder(id: number) {
    await api.cancelOrder(id).catch(() => {});
    setTimeout(loadOrders, 1000);
  }

  function onOrderPlaced() {
    setTimeout(() => {
      loadOrders();
      api.tradingStats().then((s) => stats = s).catch(() => {});
    }, 2000);
  }

  function formatTime(dateStr: string | null): string {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
  }

  function statusColor(s: string): string {
    switch (s) {
      case 'filled': return 'var(--green)';
      case 'submitted': case 'pre_submitted': return 'var(--accent)';
      case 'cancelled': return 'var(--text-muted)';
      case 'error': return 'var(--red)';
      case 'partially_filled': return 'var(--yellow)';
      default: return 'var(--text-muted)';
    }
  }

  onMount(() => {
    load();
    return onSSE('order_update', () => {
      loadOrders();
      api.tradingStats().then((s) => stats = s).catch(() => {});
    });
  });
</script>

<svelte:head>
  <title>Trading - Syphon</title>
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>Trading</h1>
    <div class="broker-connections">
      <div class="connection-status">
        <span class="dot" class:connected={ibkrConnected}></span>
        <span>IBKR</span>
        <button class="btn btn-sm" disabled={connectingIbkr} onclick={toggleIbkr}>
          {connectingIbkr ? '...' : ibkrConnected ? 'Disconnect' : 'Connect'}
        </button>
      </div>
      <div class="connection-status">
        <span class="dot" class:connected={krakenConnected}></span>
        <span>Kraken</span>
        <button class="btn btn-sm" disabled={connectingKraken} onclick={toggleKraken}>
          {connectingKraken ? '...' : krakenConnected ? 'Disconnect' : 'Connect'}
        </button>
      </div>
    </div>
  </div>

  {#if loading && !status && !orders}
    <div class="loading">Loading trading data...</div>
  {:else}
    <!-- Broker Tabs -->
    <div class="broker-tabs" style="margin-bottom: 1.5rem;">
      <button
        class="broker-tab"
        class:active={activeBroker === 'ibkr'}
        onclick={() => activeBroker = 'ibkr'}
      >IBKR</button>
      <button
        class="broker-tab"
        class:active={activeBroker === 'kraken'}
        onclick={() => activeBroker = 'kraken'}
      >Kraken</button>
    </div>

    <!-- Account & Quick Trade -->
    <div class="grid grid-2" style="margin-bottom: 1.5rem;">
      <div class="card">
        <h3 style="margin-bottom: 1rem;">
          {activeBroker === 'kraken' ? 'Kraken' : 'IBKR'} Account
        </h3>
        {#if activeBroker === 'kraken'}
          {#if krakenConnected && status?.kraken?.balance}
            <div class="account-grid">
              {#each Object.entries(status.kraken.balance).filter(([_, v]) => Number(v) > 0) as [asset, amount]}
                <div class="account-item">
                  <span class="account-label">{asset}</span>
                  <span class="account-value">{Number(amount).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                </div>
              {/each}
            </div>
            {#if status.kraken.tradeBalance && Object.keys(status.kraken.tradeBalance).length > 0}
              <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border);">
                <span class="account-label" style="margin-bottom: 0.5rem; display: block;">TRADE BALANCE</span>
                <div class="account-grid">
                  {#each Object.entries(status.kraken.tradeBalance) as [key, val]}
                    <div class="account-item">
                      <span class="account-label">{key}</span>
                      <span class="account-value" style="font-size: 0.95rem;">
                        {Number(val).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          {:else}
            <div class="empty">Connect to Kraken to view balances</div>
          {/if}
        {:else}
          {#if ibkrConnected && status?.account}
            <div class="account-grid">
              {#each Object.entries(status.account) as [key, val]}
                <div class="account-item">
                  <span class="account-label">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span class="account-value">
                    {(val as any).currency === 'USD' ? '$' : ''}{Number((val as any).value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="empty">Connect to IB to view account data</div>
          {/if}
        {/if}
      </div>

      <div class="card">
        <h3 style="margin-bottom: 1rem;">Quick Trade</h3>
        <div class="quick-trade-search">
          <input
            type="text"
            placeholder={activeBroker === 'kraken' ? 'Enter pair (e.g. BTC, ETH)...' : 'Enter ticker symbol (e.g. AAPL)...'}
            bind:value={quickSymbol}
            onkeydown={(e) => e.key === 'Enter' && (quickSymbol = quickSymbol.toUpperCase())}
          />
        </div>
        {#if quickSymbol}
          <OrderEntry symbol={quickSymbol.toUpperCase()} broker={activeBroker} {onOrderPlaced} />
        {:else}
          <div class="empty" style="padding: 1.5rem;">Enter a symbol above to start trading</div>
        {/if}
      </div>
    </div>

    <!-- Trade Stats -->
    {#if stats?.overview}
      <div class="grid grid-4" style="margin-bottom: 1.5rem;">
        <StatCard label="Total Trades" value={stats.overview.total_trades || 0} />
        <StatCard
          label="Total Volume"
          value={'$' + Number(stats.overview.total_volume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        />
        <StatCard
          label="Realized P&L"
          value={'$' + Number(stats.overview.total_realized_pnl || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          trend={Number(stats.overview.total_realized_pnl || 0) >= 0
            ? `+$${Number(stats.overview.total_realized_pnl || 0).toFixed(2)}`
            : `-$${Math.abs(Number(stats.overview.total_realized_pnl || 0)).toFixed(2)}`}
        />
        <StatCard
          label="Commissions"
          value={'$' + Number(stats.overview.total_commission || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        />
      </div>
    {/if}

    <!-- Positions -->
    {#if activeBroker === 'ibkr' && status?.positions?.length > 0}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">Open Positions (IBKR)</h3>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Position</th>
              <th>Avg Cost</th>
              <th>Account</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each status.positions as p}
              <tr>
                <td><strong>{p.symbol}</strong></td>
                <td class:positive={p.position > 0} class:negative={p.position < 0}>
                  {p.position}
                </td>
                <td class="num">${p.avgCost?.toFixed(2)}</td>
                <td class="muted">{p.account}</td>
                <td>
                  <a href="/tickers/{p.symbol}" class="btn" style="font-size: 0.8rem;">View</a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if activeBroker === 'kraken' && krakenConnected && status?.kraken?.positions && Object.keys(status.kraken.positions).length > 0}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">Open Positions (Kraken Margin)</h3>
        <table>
          <thead>
            <tr>
              <th>Pair</th>
              <th>Type</th>
              <th>Volume</th>
              <th>Cost</th>
              <th>P&L</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(status.kraken.positions) as [id, p]}
              <tr>
                <td><strong>{(p as any).pair}</strong></td>
                <td>
                  <span class="side-label {(p as any).type}">{(p as any).type?.toUpperCase()}</span>
                </td>
                <td>{(p as any).vol}</td>
                <td class="num">{(p as any).cost}</td>
                <td class="num" class:positive={Number((p as any).net) > 0} class:negative={Number((p as any).net) < 0}>
                  {(p as any).net}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- P&L by Symbol -->
    {#if stats?.bySymbol?.length > 0}
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin-bottom: 1rem;">P&L by Symbol</h3>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Trades</th>
              <th>Bought</th>
              <th>Sold</th>
              <th>P&L</th>
              <th>Commission</th>
            </tr>
          </thead>
          <tbody>
            {#each stats.bySymbol as s}
              <tr>
                <td><a href="/tickers/{s.symbol}"><strong>{s.symbol}</strong></a></td>
                <td>{s.trade_count}</td>
                <td>{s.total_bought}</td>
                <td>{s.total_sold}</td>
                <td class:positive={Number(s.pnl) > 0} class:negative={Number(s.pnl) < 0} class="num">
                  ${Number(s.pnl).toFixed(2)}
                </td>
                <td class="num">${Number(s.commission).toFixed(2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- Order History -->
    <div class="card">
      <div class="orders-header">
        <h3>Order History</h3>
        <div class="filter-row">
          <input
            type="text"
            placeholder="Symbol..."
            bind:value={symbolFilter}
            onkeydown={(e) => { if (e.key === 'Enter') { page = 1; loadOrders(); } }}
            class="symbol-input"
          />
          <select bind:value={statusFilter} onchange={() => { page = 1; loadOrders(); }}>
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="submitted">Submitted</option>
            <option value="filled">Filled</option>
            <option value="partially_filled">Partial Fill</option>
            <option value="cancelled">Cancelled</option>
            <option value="error">Error</option>
          </select>
          <select bind:value={sideFilter} onchange={() => { page = 1; loadOrders(); }}>
            <option value="">Both sides</option>
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
        </div>
      </div>

      {#if orders?.data?.length > 0}
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Broker</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Fill Price</th>
                <th>Filled</th>
                <th>Status</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each orders.data as t}
                <tr>
                  <td class="muted">#{t.id}</td>
                  <td>
                    <span class="broker-badge {t.broker || 'ibkr'}">{(t.broker || 'ibkr').toUpperCase()}</span>
                  </td>
                  <td>
                    <a href="/tickers/{t.symbol}"><strong>{t.symbol}</strong></a>
                  </td>
                  <td>
                    <span class="side-label {t.side.toLowerCase()}">{t.side}</span>
                  </td>
                  <td>{t.order_type ?? t.orderType}</td>
                  <td>{t.quantity}</td>
                  <td class="num">
                    {#if t.limit_price ?? t.limitPrice}
                      ${(t.limit_price ?? t.limitPrice).toFixed(2)}
                    {:else if t.stop_price ?? t.stopPrice}
                      ${(t.stop_price ?? t.stopPrice).toFixed(2)}
                    {:else}
                      MKT
                    {/if}
                  </td>
                  <td class="num">
                    {t.fill_price ?? t.fillPrice ? `$${(t.fill_price ?? t.fillPrice).toFixed(2)}` : '-'}
                  </td>
                  <td>{t.filled_quantity ?? t.filledQuantity}/{t.quantity}</td>
                  <td>
                    <span class="status-badge" style="color: {statusColor(t.status)}">
                      {t.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td class="time">{formatTime(t.created_at ?? t.createdAt)}</td>
                  <td>
                    {#if ['submitted', 'pre_submitted', 'pending'].includes(t.status)}
                      <button class="btn cancel-btn" onclick={() => cancelOrder(t.id)}>Cancel</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#if orders.meta?.last_page > 1}
          <div class="pagination">
            <button class="btn" disabled={page <= 1} onclick={() => { page--; loadOrders(); }}>Prev</button>
            <span style="color: var(--text-muted); align-self: center;">
              Page {page} of {orders.meta.last_page}
            </span>
            <button class="btn" disabled={page >= orders.meta.last_page} onclick={() => { page++; loadOrders(); }}>Next</button>
          </div>
        {/if}
      {:else}
        <div class="empty">No orders yet. Use the Quick Trade panel or trade from a ticker page.</div>
      {/if}
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
    gap: 1rem;
  }
  .broker-connections {
    display: flex;
    gap: 1.25rem;
  }
  .connection-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--red);
    flex-shrink: 0;
  }
  .dot.connected {
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
  }
  .broker-tabs {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    width: fit-content;
  }
  .broker-tab {
    padding: 0.5rem 1.25rem;
    background: var(--bg);
    border: none;
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .broker-tab.active {
    background: var(--accent);
    color: white;
  }
  .broker-tab:hover:not(.active) {
    background: var(--bg-hover);
  }
  .broker-badge {
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .broker-badge.ibkr {
    background: rgba(99, 102, 241, 0.15);
    color: var(--accent);
  }
  .broker-badge.kraken {
    background: rgba(139, 92, 246, 0.15);
    color: #8b5cf6;
  }
  .quick-trade-search {
    margin-bottom: 1rem;
  }
  .quick-trade-search input {
    width: 100%;
  }
  .account-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.75rem;
  }
  .account-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .account-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .account-value {
    font-size: 1.1rem;
    font-weight: 700;
    font-family: 'SF Mono', monospace;
  }
  .orders-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .filter-row {
    display: flex;
    gap: 0.5rem;
  }
  .symbol-input {
    width: 100px;
    text-transform: uppercase;
  }
  .table-wrapper {
    overflow-x: auto;
  }
  .side-label {
    font-weight: 700;
    font-size: 0.8rem;
  }
  .side-label.buy { color: var(--green); }
  .side-label.sell { color: var(--red); }
  .status-badge {
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: capitalize;
  }
  .num {
    font-family: 'SF Mono', monospace;
    font-size: 0.85rem;
  }
  .muted { color: var(--text-muted); }
  .time { color: var(--text-muted); font-size: 0.8rem; white-space: nowrap; }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .cancel-btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    color: var(--red);
    border-color: var(--red);
  }
</style>
