<script lang="ts">
  import SentimentBadge from './SentimentBadge.svelte';

  interface Props {
    analyses: any[];
  }

  let { analyses }: Props = $props();

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

{#if analyses.length === 0}
  <div class="empty">No analyses yet</div>
{:else}
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Article</th>
          <th>Sentiment</th>
          <th>Score</th>
          <th>Relevance</th>
          <th>Confidence</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        {#each analyses as a}
          <tr>
            <td>
              <a href="/tickers/{a.ticker?.symbol}">
                <strong>{a.ticker?.symbol}</strong>
              </a>
            </td>
            <td class="title-cell">
              <a href="/articles/{a.article?.id || a.article_id}">
                {(a.article?.title || '').slice(0, 60)}{(a.article?.title || '').length > 60 ? '...' : ''}
              </a>
            </td>
            <td>
              <SentimentBadge sentiment={a.sentiment} score={a.sentiment_score ?? a.sentimentScore} />
            </td>
            <td class="num" class:positive={Number(a.sentiment_score ?? a.sentimentScore) > 0} class:negative={Number(a.sentiment_score ?? a.sentimentScore) < 0}>
              {Number(a.sentiment_score ?? a.sentimentScore ?? 0).toFixed(3)}
            </td>
            <td class="num">{Number(a.relevance_score ?? a.relevanceScore ?? 0).toFixed(3)}</td>
            <td class="num">{(Number(a.confidence ?? 0) * 100).toFixed(1)}%</td>
            <td class="time">{timeAgo(a.created_at || a.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .table-wrapper {
    overflow-x: auto;
  }
  .title-cell {
    max-width: 300px;
  }
  .num {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.85rem;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .time {
    color: var(--text-muted);
    font-size: 0.8rem;
    white-space: nowrap;
  }
</style>
