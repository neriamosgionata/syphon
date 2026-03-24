<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';

  let screenerData: any = $state(null);
  let detail: any = $state(null);
  let loading = $state(true);
  let detailLoading = $state(false);
  let error = $state('');
  let signalFilter = $state('');
  let patternFilter = $state('');
  let sortBy = $state('composite_score');
  let sortDir = $state<'desc' | 'asc'>('desc');
  let searchQuery = $state('');
  let selectedSymbol = $state('');

  async function loadScreener() {
    loading = true;
    error = '';
    try {
      screenerData = await api.quantScreener();
    } catch (e: any) {
      error = e.message;
    }
    loading = false;
  }

  async function loadDetail(symbol: string) {
    selectedSymbol = symbol;
    detailLoading = true;
    try {
      detail = await api.quantAnalyze(symbol);
    } catch (e: any) {
      detail = null;
    }
    detailLoading = false;
  }

  function closeDetail() {
    selectedSymbol = '';
    detail = null;
  }

  let filteredTickers = $derived(() => {
    if (!screenerData?.tickers) return [];
    let list = screenerData.tickers;
    if (signalFilter) list = list.filter((t: any) => t.signal === signalFilter);
    if (patternFilter) list = list.filter((t: any) => t.patterns.includes(patternFilter));
    if (searchQuery) {
      const q = searchQuery.toUpperCase();
      list = list.filter((t: any) => t.symbol.includes(q) || t.name.toUpperCase().includes(q));
    }

    const key = sortBy;
    list = [...list].sort((a: any, b: any) => {
      const va = a[key] ?? -Infinity;
      const vb = b[key] ?? -Infinity;
      return sortDir === 'desc' ? vb - va : va - vb;
    });
    return list;
  });

  let signalCounts = $derived(() => {
    if (!screenerData?.tickers) return {};
    const counts: Record<string, number> = {};
    for (const t of screenerData.tickers) {
      counts[t.signal] = (counts[t.signal] || 0) + 1;
    }
    return counts;
  });

  let allPatterns = $derived(() => {
    if (!screenerData?.tickers) return [];
    const set = new Set<string>();
    for (const t of screenerData.tickers) {
      for (const p of t.patterns) set.add(p);
    }
    return [...set].sort();
  });

  function toggleSort(col: string) {
    if (sortBy === col) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    else { sortBy = col; sortDir = 'desc'; }
  }

  function signalColor(signal: string) {
    if (signal === 'strong_buy') return 'var(--very-bullish)';
    if (signal === 'buy') return 'var(--bullish)';
    if (signal === 'sell') return 'var(--bearish)';
    if (signal === 'strong_sell') return 'var(--very-bearish)';
    return 'var(--neutral)';
  }

  function scoreBar(score: number) {
    const pct = Math.min(100, Math.max(0, (score + 100) / 2));
    const color = score > 20 ? 'var(--green)' : score < -20 ? 'var(--red)' : 'var(--yellow)';
    return { pct, color };
  }

  function rsiColor(rsi: number | null) {
    if (rsi === null) return 'var(--text-muted)';
    if (rsi > 70) return 'var(--red)';
    if (rsi < 30) return 'var(--green)';
    return 'var(--text)';
  }

  function fmtPct(val: number | null) {
    if (val === null) return '-';
    return (val >= 0 ? '+' : '') + val.toFixed(1) + '%';
  }

  function fmtNum(val: number | null, decimals = 2) {
    if (val === null) return '-';
    return val.toFixed(decimals);
  }

  function patternLabel(p: string) {
    return p.replace(/_/g, ' ');
  }

  onMount(loadScreener);
</script>

<svelte:head><title>Quant Analysis | Syphon</title></svelte:head>

<div class="container page">
  <header class="page-header">
    <div>
      <h1>Quant Engine</h1>
      <p class="subtitle">Technical indicators, statistical risk metrics, and pattern detection across {screenerData?.count || 0} tickers</p>
    </div>
    <button class="btn" onclick={loadScreener} disabled={loading}>
      {loading ? 'Analyzing...' : 'Refresh'}
    </button>
  </header>

  {#if error}
    <div class="alert error">{error}</div>
  {/if}

  <!-- Signal summary chips -->
  {#if screenerData}
    <div class="signal-chips">
      <button class="chip" class:active={!signalFilter} onclick={() => signalFilter = ''}>
        All ({screenerData.count})
      </button>
      {#each ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'] as sig}
        {@const count = signalCounts()[sig] || 0}
        {#if count > 0}
          <button
            class="chip"
            class:active={signalFilter === sig}
            style="--chip-color: {signalColor(sig)}"
            onclick={() => signalFilter = signalFilter === sig ? '' : sig}
          >
            {sig.replace('_', ' ')} ({count})
          </button>
        {/if}
      {/each}
    </div>

    <!-- Filters row -->
    <div class="filters-row">
      <input type="text" placeholder="Search symbol or name..." bind:value={searchQuery} class="search-input" />
      <select bind:value={patternFilter} class="filter-select">
        <option value="">All Patterns</option>
        {#each allPatterns() as p}
          <option value={p}>{patternLabel(p)}</option>
        {/each}
      </select>
    </div>
  {/if}

  <!-- Screener table -->
  {#if loading}
    <div class="loading-state">Analyzing {screenerData?.count || '...'} tickers...</div>
  {:else if screenerData}
    <div class="table-wrapper">
      <table class="quant-table">
        <thead>
          <tr>
            <th class="sticky-col" onclick={() => toggleSort('symbol')}>Symbol {sortBy === 'symbol' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('composite_score')}>Score {sortBy === 'composite_score' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th>Signal</th>
            <th onclick={() => toggleSort('rsi14')}>RSI {sortBy === 'rsi14' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('macd_histogram')}>MACD {sortBy === 'macd_histogram' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th>Trend</th>
            <th onclick={() => toggleSort('bollinger_position')}>BB% {sortBy === 'bollinger_position' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('volatility20d')}>Vol {sortBy === 'volatility20d' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('volume_ratio')}>Vol.R {sortBy === 'volume_ratio' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('return20d')}>Ret20d {sortBy === 'return20d' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('sharpe')}>Sharpe {sortBy === 'sharpe' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('beta')}>Beta {sortBy === 'beta' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th onclick={() => toggleSort('max_drawdown')}>MaxDD {sortBy === 'max_drawdown' ? (sortDir === 'desc' ? 'v' : '^') : ''}</th>
            <th>Patterns</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredTickers() as t (t.symbol)}
            {@const bar = scoreBar(t.composite_score)}
            <tr onclick={() => loadDetail(t.symbol)} class:selected={selectedSymbol === t.symbol}>
              <td class="sticky-col symbol-cell">
                <span class="symbol">{t.symbol}</span>
                <span class="name">{t.name}</span>
              </td>
              <td>
                <div class="score-cell">
                  <div class="score-bar-bg"><div class="score-bar-fill" style="width:{bar.pct}%; background:{bar.color}"></div></div>
                  <span class="score-val">{t.composite_score}</span>
                </div>
              </td>
              <td><span class="signal-badge" style="color:{signalColor(t.signal)}">{t.signal.replace('_', ' ')}</span></td>
              <td style="color:{rsiColor(t.rsi14)}">{fmtNum(t.rsi14, 1)}</td>
              <td style="color:{t.macd_histogram > 0 ? 'var(--green)' : t.macd_histogram < 0 ? 'var(--red)' : 'var(--text-muted)'}">{fmtNum(t.macd_histogram)}</td>
              <td>
                {#if t.sma_trend === 'bullish'}<span class="trend-up">UP</span>
                {:else if t.sma_trend === 'bearish'}<span class="trend-down">DN</span>
                {:else}<span class="trend-flat">--</span>{/if}
              </td>
              <td>{fmtNum(t.bollinger_position)}</td>
              <td>{t.volatility20d ? t.volatility20d.toFixed(1) + '%' : '-'}</td>
              <td style="color:{(t.volume_ratio || 0) > 1.5 ? 'var(--yellow)' : 'var(--text-muted)'}">{fmtNum(t.volume_ratio, 1)}x</td>
              <td style="color:{(t.return20d || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">{fmtPct(t.return20d)}</td>
              <td style="color:{(t.sharpe || 0) > 1 ? 'var(--green)' : (t.sharpe || 0) < 0 ? 'var(--red)' : 'var(--text-muted)'}">{fmtNum(t.sharpe)}</td>
              <td>{fmtNum(t.beta)}</td>
              <td style="color:var(--red)">{t.max_drawdown ? t.max_drawdown.toFixed(1) + '%' : '-'}</td>
              <td class="patterns-cell">
                {#each t.patterns.slice(0, 3) as p}
                  <span class="pattern-tag">{patternLabel(p)}</span>
                {/each}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <!-- Detail panel -->
  {#if selectedSymbol && detail}
    <div class="detail-overlay" onclick={closeDetail}>
      <div class="detail-panel" onclick={(e) => e.stopPropagation()}>
        <div class="detail-header">
          <div>
            <h2>{detail.symbol} <span class="detail-name">{detail.name}</span></h2>
            <span class="detail-exchange">{detail.exchange}</span>
            <span class="detail-points">{detail.dataPoints} data points</span>
          </div>
          <div class="detail-score">
            <span class="big-score" style="color:{signalColor(detail.quantSignal)}">{detail.compositeScore}</span>
            <span class="signal-label" style="color:{signalColor(detail.quantSignal)}">{detail.quantSignal.replace('_', ' ')}</span>
          </div>
        </div>

        <div class="detail-grid">
          <!-- Moving Averages -->
          <div class="detail-section">
            <h3>Moving Averages</h3>
            <div class="kv-grid">
              <div class="kv"><span>SMA 20</span><span>{fmtNum(detail.sma20)}</span></div>
              <div class="kv"><span>SMA 50</span><span>{fmtNum(detail.sma50)}</span></div>
              <div class="kv"><span>SMA 200</span><span>{fmtNum(detail.sma200)}</span></div>
              <div class="kv"><span>EMA 12</span><span>{fmtNum(detail.ema12)}</span></div>
              <div class="kv"><span>EMA 26</span><span>{fmtNum(detail.ema26)}</span></div>
              <div class="kv"><span>Price</span><span>${Number(detail.currentPrice).toFixed(2)}</span></div>
            </div>
            {#if detail.sma20 && detail.sma50 && detail.sma200}
              <div class="ma-visual">
                {#if Number(detail.currentPrice) > detail.sma20 && detail.sma20 > detail.sma50 && detail.sma50 > detail.sma200}
                  <span class="ma-badge bullish">Bullish Alignment</span>
                {:else if Number(detail.currentPrice) < detail.sma20 && detail.sma20 < detail.sma50 && detail.sma50 < detail.sma200}
                  <span class="ma-badge bearish">Bearish Alignment</span>
                {:else}
                  <span class="ma-badge neutral">Mixed</span>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Oscillators -->
          <div class="detail-section">
            <h3>Oscillators</h3>
            <div class="kv-grid">
              <div class="kv"><span>RSI (14)</span><span style="color:{rsiColor(detail.rsi14)}">{fmtNum(detail.rsi14, 1)}</span></div>
              {#if detail.macd}
                <div class="kv"><span>MACD</span><span>{fmtNum(detail.macd.macd, 3)}</span></div>
                <div class="kv"><span>Signal</span><span>{fmtNum(detail.macd.signal, 3)}</span></div>
                <div class="kv"><span>Histogram</span><span style="color:{detail.macd.histogram > 0 ? 'var(--green)' : 'var(--red)'}">{fmtNum(detail.macd.histogram, 3)}</span></div>
              {/if}
              {#if detail.stochastic}
                <div class="kv"><span>Stoch %K</span><span>{fmtNum(detail.stochastic.k, 1)}</span></div>
                <div class="kv"><span>Stoch %D</span><span>{fmtNum(detail.stochastic.d, 1)}</span></div>
              {/if}
              {#if detail.adx}
                <div class="kv"><span>ADX</span><span>{fmtNum(detail.adx.adx, 1)}</span></div>
                <div class="kv"><span>+DI / -DI</span><span>{fmtNum(detail.adx.plusDI, 1)} / {fmtNum(detail.adx.minusDI, 1)}</span></div>
              {/if}
            </div>
            <!-- RSI gauge -->
            {#if detail.rsi14 !== null}
              <div class="gauge">
                <div class="gauge-bar">
                  <div class="gauge-zone oversold" style="width:30%"></div>
                  <div class="gauge-zone neutral-zone" style="width:40%"></div>
                  <div class="gauge-zone overbought" style="width:30%"></div>
                  <div class="gauge-needle" style="left:{detail.rsi14}%"></div>
                </div>
                <div class="gauge-labels"><span>Oversold</span><span>Neutral</span><span>Overbought</span></div>
              </div>
            {/if}
          </div>

          <!-- Volatility -->
          <div class="detail-section">
            <h3>Volatility</h3>
            <div class="kv-grid">
              <div class="kv"><span>ATR (14)</span><span>{fmtNum(detail.atr14)}</span></div>
              <div class="kv"><span>Vol 20d</span><span>{detail.volatility20d ? (detail.volatility20d * 100).toFixed(1) + '%' : '-'}</span></div>
              <div class="kv"><span>Vol 60d</span><span>{detail.volatility60d ? (detail.volatility60d * 100).toFixed(1) + '%' : '-'}</span></div>
              {#if detail.bollingerBands}
                <div class="kv"><span>BB Upper</span><span>{fmtNum(detail.bollingerBands.upper)}</span></div>
                <div class="kv"><span>BB Lower</span><span>{fmtNum(detail.bollingerBands.lower)}</span></div>
                <div class="kv"><span>BB %B</span><span>{fmtNum(detail.bollingerBands.percentB, 3)}</span></div>
                <div class="kv"><span>BB Width</span><span>{fmtNum(detail.bollingerBands.width, 4)}</span></div>
              {/if}
            </div>
          </div>

          <!-- Volume -->
          <div class="detail-section">
            <h3>Volume</h3>
            <div class="kv-grid">
              <div class="kv"><span>OBV</span><span>{detail.obv !== null ? (detail.obv / 1e6).toFixed(1) + 'M' : '-'}</span></div>
              <div class="kv"><span>OBV Trend</span><span class="trend-{detail.obvTrend || 'flat'}">{detail.obvTrend || '-'}</span></div>
              <div class="kv"><span>Vol SMA 20</span><span>{detail.volumeSma20 ? (detail.volumeSma20 / 1e6).toFixed(1) + 'M' : '-'}</span></div>
              <div class="kv"><span>Vol Ratio</span><span style="color:{(detail.volumeRatio || 0) > 1.5 ? 'var(--yellow)' : 'inherit'}">{fmtNum(detail.volumeRatio, 2)}x</span></div>
            </div>
          </div>

          <!-- Returns & Risk -->
          <div class="detail-section">
            <h3>Returns & Risk</h3>
            <div class="kv-grid">
              <div class="kv"><span>1d</span><span style="color:{(detail.returnDaily || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">{fmtPct(detail.returnDaily ? detail.returnDaily * 100 : null)}</span></div>
              <div class="kv"><span>5d</span><span style="color:{(detail.return5d || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">{fmtPct(detail.return5d ? detail.return5d * 100 : null)}</span></div>
              <div class="kv"><span>20d</span><span style="color:{(detail.return20d || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">{fmtPct(detail.return20d ? detail.return20d * 100 : null)}</span></div>
              <div class="kv"><span>60d</span><span style="color:{(detail.return60d || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">{fmtPct(detail.return60d ? detail.return60d * 100 : null)}</span></div>
              <div class="kv"><span>Sharpe</span><span style="color:{(detail.sharpeRatio || 0) > 1 ? 'var(--green)' : (detail.sharpeRatio || 0) < 0 ? 'var(--red)' : 'inherit'}">{fmtNum(detail.sharpeRatio)}</span></div>
              <div class="kv"><span>Sortino</span><span>{fmtNum(detail.sortinoRatio)}</span></div>
              <div class="kv"><span>Max Drawdown</span><span style="color:var(--red)">{detail.maxDrawdown ? (detail.maxDrawdown * 100).toFixed(1) + '%' : '-'}</span></div>
              <div class="kv"><span>Beta (SPY)</span><span>{fmtNum(detail.beta)}</span></div>
            </div>
          </div>

          <!-- Fundamentals -->
          <div class="detail-section">
            <h3>Fundamentals</h3>
            <div class="kv-grid">
              <div class="kv"><span>P/E</span><span>{fmtNum(detail.pe, 1)}</span></div>
              <div class="kv"><span>EPS</span><span>{fmtNum(detail.eps)}</span></div>
              <div class="kv"><span>Div Yield</span><span>{detail.dividendYield ? (detail.dividendYield * 100).toFixed(2) + '%' : '-'}</span></div>
              <div class="kv"><span>Market Cap</span><span>{detail.marketCap ? '$' + (Number(detail.marketCap) / 1e9).toFixed(0) + 'B' : '-'}</span></div>
            </div>
          </div>
        </div>

        <!-- Patterns -->
        {#if detail.patterns.length > 0}
          <div class="detail-section patterns-section">
            <h3>Detected Patterns</h3>
            <div class="patterns-list">
              {#each detail.patterns as p}
                <div class="pattern-item {p.signal}">
                  <div class="pattern-head">
                    <span class="pattern-name">{patternLabel(p.type)}</span>
                    <span class="pattern-signal">{p.signal}</span>
                    <div class="strength-bar"><div class="strength-fill" style="width:{p.strength}%; background:{p.signal === 'bullish' ? 'var(--green)' : p.signal === 'bearish' ? 'var(--red)' : 'var(--yellow)'}"></div></div>
                  </div>
                  <p class="pattern-desc">{p.description}</p>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <button class="close-btn" onclick={closeDetail}>Close</button>
      </div>
    </div>
  {:else if detailLoading}
    <div class="detail-overlay"><div class="detail-panel"><p>Loading analysis...</p></div></div>
  {/if}
</div>

<style>
  .page { padding: 2rem 0; }
  .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; }
  .page-header h1 { font-size: 1.75rem; font-weight: 800; }
  .subtitle { color: var(--text-muted); font-size: 0.9rem; margin-top: 0.25rem; }
  .btn { padding: 0.5rem 1.25rem; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); border-radius: var(--radius); cursor: pointer; font-weight: 600; }
  .btn:hover { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .alert.error { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: var(--red); padding: 0.75rem 1rem; border-radius: var(--radius); margin-bottom: 1rem; }

  .signal-chips { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .chip { padding: 0.35rem 0.85rem; border-radius: 20px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-muted); cursor: pointer; font-size: 0.8rem; font-weight: 600; text-transform: capitalize; }
  .chip.active { border-color: var(--chip-color, var(--accent)); color: var(--chip-color, var(--accent)); background: rgba(99,102,241,0.1); }

  .filters-row { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
  .search-input { flex: 1; max-width: 300px; padding: 0.5rem 0.75rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 0.85rem; }
  .filter-select { padding: 0.5rem 0.75rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 0.85rem; text-transform: capitalize; }

  .loading-state { text-align: center; padding: 3rem; color: var(--text-muted); }

  .table-wrapper { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); }
  .quant-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .quant-table th { padding: 0.6rem 0.75rem; text-align: left; background: var(--bg-card); color: var(--text-muted); font-weight: 700; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; white-space: nowrap; user-select: none; border-bottom: 1px solid var(--border); }
  .quant-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .quant-table tbody tr { cursor: pointer; transition: background 0.1s; }
  .quant-table tbody tr:hover, .quant-table tbody tr.selected { background: var(--bg-hover); }

  .symbol-cell { display: flex; flex-direction: column; gap: 0.1rem; }
  .symbol { font-weight: 700; color: var(--text); font-size: 0.85rem; }
  .name { color: var(--text-muted); font-size: 0.7rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }

  .score-cell { display: flex; align-items: center; gap: 0.5rem; min-width: 100px; }
  .score-bar-bg { flex: 1; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .score-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .score-val { font-weight: 700; font-family: 'SF Mono', monospace; font-size: 0.8rem; min-width: 28px; text-align: right; }

  .signal-badge { font-weight: 700; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.03em; }
  .trend-up { color: var(--green); font-weight: 700; }
  .trend-down { color: var(--red); font-weight: 700; }
  .trend-flat { color: var(--text-muted); }

  .patterns-cell { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .pattern-tag { padding: 0.15rem 0.4rem; border-radius: 4px; background: var(--bg-hover); color: var(--text-muted); font-size: 0.65rem; text-transform: capitalize; }

  /* Detail overlay */
  .detail-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; display: flex; justify-content: flex-end; backdrop-filter: blur(2px); }
  .detail-panel { width: 640px; max-width: 100vw; height: 100vh; overflow-y: auto; background: var(--bg); border-left: 1px solid var(--border); padding: 2rem; }
  .detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; }
  .detail-header h2 { font-size: 1.4rem; font-weight: 800; }
  .detail-name { font-weight: 400; color: var(--text-muted); font-size: 1rem; }
  .detail-exchange { background: var(--bg-card); padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; color: var(--text-muted); margin-right: 0.5rem; }
  .detail-points { color: var(--text-muted); font-size: 0.75rem; }
  .detail-score { text-align: right; }
  .big-score { font-size: 2.5rem; font-weight: 900; font-family: 'SF Mono', monospace; display: block; line-height: 1; }
  .signal-label { text-transform: uppercase; font-weight: 700; font-size: 0.8rem; letter-spacing: 0.05em; }

  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  .detail-section { background: var(--bg-card); border-radius: var(--radius); padding: 1rem; border: 1px solid var(--border); }
  .detail-section h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 0.75rem; font-weight: 700; }
  .kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
  .kv { display: flex; justify-content: space-between; font-size: 0.82rem; }
  .kv span:first-child { color: var(--text-muted); }
  .kv span:last-child { font-weight: 600; font-family: 'SF Mono', monospace; }

  .ma-visual { margin-top: 0.75rem; }
  .ma-badge { padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; }
  .ma-badge.bullish { background: rgba(34,197,94,0.15); color: var(--green); }
  .ma-badge.bearish { background: rgba(239,68,68,0.15); color: var(--red); }
  .ma-badge.neutral { background: rgba(107,114,128,0.15); color: var(--text-muted); }

  /* RSI Gauge */
  .gauge { margin-top: 0.75rem; }
  .gauge-bar { position: relative; height: 8px; border-radius: 4px; display: flex; overflow: hidden; }
  .gauge-zone { height: 100%; }
  .oversold { background: rgba(34,197,94,0.3); }
  .neutral-zone { background: rgba(107,114,128,0.2); }
  .overbought { background: rgba(239,68,68,0.3); }
  .gauge-needle { position: absolute; top: -3px; width: 3px; height: 14px; background: white; border-radius: 2px; transform: translateX(-50%); }
  .gauge-labels { display: flex; justify-content: space-between; font-size: 0.65rem; color: var(--text-muted); margin-top: 0.2rem; }

  .trend-rising { color: var(--green); }
  .trend-falling { color: var(--red); }
  .trend-flat { color: var(--text-muted); }

  .patterns-section { grid-column: 1 / -1; }
  .patterns-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .pattern-item { padding: 0.6rem 0.75rem; border-radius: var(--radius); border-left: 3px solid var(--text-muted); background: var(--bg); }
  .pattern-item.bullish { border-left-color: var(--green); }
  .pattern-item.bearish { border-left-color: var(--red); }
  .pattern-item.neutral { border-left-color: var(--yellow); }
  .pattern-head { display: flex; align-items: center; gap: 0.75rem; }
  .pattern-name { font-weight: 700; font-size: 0.85rem; text-transform: capitalize; }
  .pattern-signal { font-size: 0.7rem; text-transform: uppercase; font-weight: 700; }
  .pattern-item.bullish .pattern-signal { color: var(--green); }
  .pattern-item.bearish .pattern-signal { color: var(--red); }
  .pattern-item.neutral .pattern-signal { color: var(--yellow); }
  .strength-bar { flex: 1; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; max-width: 80px; }
  .strength-fill { height: 100%; border-radius: 2px; }
  .pattern-desc { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.3rem; }

  .close-btn { width: 100%; margin-top: 1.5rem; padding: 0.6rem; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); cursor: pointer; font-weight: 600; }
  .close-btn:hover { background: var(--bg-hover); }

  @media (max-width: 768px) {
    .detail-panel { width: 100vw; }
    .detail-grid { grid-template-columns: 1fr; }
    .filters-row { flex-direction: column; }
    .search-input { max-width: 100%; }
  }
</style>
