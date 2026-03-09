<script lang="ts">
  import SentimentBadge from './SentimentBadge.svelte';

  interface Props {
    article: any;
  }

  let { article }: Props = $props();

  function timeAgo(dateStr: string): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
</script>

<div class="card article-card">
  <div class="article-header">
    <span class="source">{article.source_name || article.sourceName}</span>
    <span class="time">{timeAgo(article.published_at || article.publishedAt)}</span>
  </div>
  <h3 class="article-title">
    <a href="/articles/{article.id}">{article.title}</a>
  </h3>
  {#if article.summary}
    <p class="article-summary">{article.summary.slice(0, 200)}{article.summary.length > 200 ? '...' : ''}</p>
  {/if}
  <div class="article-footer">
    {#if article.analyses?.length > 0}
      <div class="analyses-badges">
        {#each article.analyses.slice(0, 3) as analysis}
          <div class="analysis-chip">
            <span class="ticker-label">{analysis.ticker?.symbol}</span>
            <SentimentBadge sentiment={analysis.sentiment} score={analysis.sentiment_score || analysis.sentimentScore} />
          </div>
        {/each}
      </div>
    {:else if !article.is_analyzed && !article.isAnalyzed}
      <span class="pending">Pending analysis</span>
    {/if}
    <a href={article.url} target="_blank" rel="noopener" class="external-link">Source</a>
  </div>
</div>

<style>
  .article-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .article-header {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
  }
  .source {
    color: var(--accent);
    font-weight: 600;
  }
  .time {
    color: var(--text-muted);
  }
  .article-title {
    font-size: 1rem;
    line-height: 1.4;
  }
  .article-title a {
    color: var(--text);
  }
  .article-title a:hover {
    color: var(--accent);
  }
  .article-summary {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .article-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .analyses-badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .analysis-chip {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .ticker-label {
    font-weight: 700;
    font-size: 0.8rem;
    color: var(--text);
  }
  .pending {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-style: italic;
  }
  .external-link {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .external-link:hover {
    color: var(--accent);
  }
</style>
