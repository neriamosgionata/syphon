<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';

  let article: any = $state(null);
  let loading = $state(true);

  onMount(async () => {
    const id = Number($page.params.id);
    try {
      article = await api.article(id);
    } catch {}
    loading = false;
  });
</script>

<svelte:head>
  <title>{article?.title || 'Article'} - Syphon</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading...</div>
{:else if article}
  <div class="page">
    <a href="/articles" style="color: var(--text-muted); font-size: 0.85rem;">Back to articles</a>

    <div class="card" style="margin-top: 1rem;">
      <div class="article-meta">
        <span class="source">{article.source_name || article.sourceName}</span>
        {#if article.author}
          <span>by {article.author}</span>
        {/if}
        {#if article.published_at || article.publishedAt}
          <span>{new Date(article.published_at || article.publishedAt).toLocaleDateString()}</span>
        {/if}
      </div>
      <h1 style="margin: 1rem 0;">{article.title}</h1>
      {#if article.summary}
        <p style="color: var(--text-muted); margin-bottom: 1rem;">{article.summary}</p>
      {/if}
      {#if article.content}
        <div class="content">{article.content}</div>
      {/if}
      <a href={article.url} target="_blank" rel="noopener" class="btn" style="margin-top: 1rem;">View Original</a>
    </div>

    {#if article.analyses?.length > 0}
      <h2 style="margin: 2rem 0 1rem;">Ticker Analyses</h2>
      <div class="analyses-list">
        {#each article.analyses as a}
          <div class="card analysis-detail">
            <div class="analysis-header">
              <a href="/tickers/{a.ticker?.symbol}" class="ticker-link">
                <strong>{a.ticker?.symbol}</strong>
                <span class="ticker-name">{a.ticker?.name}</span>
              </a>
              <SentimentBadge sentiment={a.sentiment} score={a.sentiment_score ?? a.sentimentScore} />
            </div>
            <div class="analysis-scores">
              <div>
                <span class="score-label">Score</span>
                <span class="score-value" class:positive={(a.sentiment_score ?? a.sentimentScore) > 0} class:negative={(a.sentiment_score ?? a.sentimentScore) < 0}>
                  {Number(a.sentiment_score ?? a.sentimentScore).toFixed(3)}
                </span>
              </div>
              <div>
                <span class="score-label">Relevance</span>
                <span class="score-value">{Number(a.relevance_score ?? a.relevanceScore).toFixed(3)}</span>
              </div>
              <div>
                <span class="score-label">Confidence</span>
                <span class="score-value">{((a.confidence ?? 0) * 100).toFixed(1)}%</span>
              </div>
              {#if a.ticker_price_at_analysis ?? a.tickerPriceAtAnalysis}
                <div>
                  <span class="score-label">Price at Analysis</span>
                  <span class="score-value">${Number(a.ticker_price_at_analysis ?? a.tickerPriceAtAnalysis).toFixed(2)}</span>
                </div>
              {/if}
            </div>
            {#if a.reasoning}
              <p class="reasoning">{a.reasoning}</p>
            {/if}
            {#if a.keywords?.length > 0}
              <div class="keywords">
                {#each a.keywords as kw}
                  <span class="keyword">{kw}</span>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <div class="empty card">Article not found</div>
{/if}

<style>
  .article-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .source { color: var(--accent); font-weight: 600; }
  .content {
    line-height: 1.8;
    color: var(--text);
  }
  .analyses-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .analysis-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .ticker-link {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .ticker-name {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .analysis-scores {
    display: flex;
    gap: 2rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .score-label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .score-value {
    font-size: 1.1rem;
    font-weight: 700;
    font-family: 'SF Mono', monospace;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .reasoning {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }
  .keywords {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .keyword {
    padding: 0.15rem 0.5rem;
    background: var(--bg);
    border-radius: 4px;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
</style>
