<script lang="ts">
  import { onMount } from 'svelte';
  import { onSSE } from '$lib/sse';

  interface TickerMatchNotification {
    type: string;
    articleId: number;
    articleTitle: string;
    articleUrl: string | null;
    sourceName: string | null;
    ticker: {
      symbol: string;
      name: string;
      currentPrice: number | null;
    };
    sentiment: string;
    sentimentScore: number;
    relevanceScore: number;
    confidence: number;
    keywords: string[] | null;
    timestamp: string;
  }

  interface Toast {
    id: number;
    notification: TickerMatchNotification;
    dismissing: boolean;
  }

  let toasts: Toast[] = $state([]);
  let nextId = 0;

  const sentimentLabels: Record<string, string> = {
    very_bullish: 'Very Bullish',
    bullish: 'Bullish',
    neutral: 'Neutral',
    bearish: 'Bearish',
    very_bearish: 'Very Bearish',
  };

  const sentimentColors: Record<string, string> = {
    very_bullish: 'var(--very-bullish)',
    bullish: 'var(--bullish)',
    neutral: 'var(--neutral)',
    bearish: 'var(--bearish)',
    very_bearish: 'var(--very-bearish)',
  };

  function addToast(notification: TickerMatchNotification) {
    const id = nextId++;
    toasts = [...toasts, { id, notification, dismissing: false }];

    // Auto-dismiss after 8 seconds
    setTimeout(() => dismissToast(id), 8000);
  }

  function dismissToast(id: number) {
    toasts = toasts.map((t) => (t.id === id ? { ...t, dismissing: true } : t));
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 300);
  }

  onMount(() => {
    return onSSE('ticker_match', (data: TickerMatchNotification) => {
      addToast(data);
    });
  });
</script>

{#if toasts.length > 0}
  <div class="toast-container">
    {#each toasts as toast (toast.id)}
      <div
        class="toast"
        class:dismissing={toast.dismissing}
        style="border-left-color: {sentimentColors[toast.notification.sentiment] || 'var(--accent)'}"
      >
        <button class="toast-close" onclick={() => dismissToast(toast.id)}>&times;</button>
        <div class="toast-header">
          <span class="toast-ticker">{toast.notification.ticker.symbol}</span>
          <span
            class="toast-sentiment badge {toast.notification.sentiment}"
          >
            {sentimentLabels[toast.notification.sentiment] || toast.notification.sentiment}
          </span>
        </div>
        <div class="toast-title">{toast.notification.articleTitle}</div>
        <div class="toast-meta">
          {#if toast.notification.ticker.currentPrice != null}
            <span class="toast-price">${toast.notification.ticker.currentPrice.toFixed(2)}</span>
          {/if}
          <span class="toast-score">Score: {toast.notification.sentimentScore.toFixed(3)}</span>
          <span class="toast-confidence">Conf: {(toast.notification.confidence * 100).toFixed(0)}%</span>
        </div>
        {#if toast.notification.keywords && toast.notification.keywords.length > 0}
          <div class="toast-keywords">
            {toast.notification.keywords.slice(0, 4).join(', ')}
          </div>
        {/if}
        {#if toast.notification.sourceName}
          <div class="toast-source">{toast.notification.sourceName}</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: 4.5rem;
    right: 1.5rem;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-height: calc(100vh - 6rem);
    overflow-y: auto;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: var(--radius);
    padding: 0.875rem 1rem;
    width: 340px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    animation: slideIn 0.3s ease-out;
    position: relative;
  }

  .toast.dismissing {
    animation: slideOut 0.3s ease-in forwards;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(100%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes slideOut {
    from {
      opacity: 1;
      transform: translateX(0);
    }
    to {
      opacity: 0;
      transform: translateX(100%);
    }
  }

  .toast-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }
  .toast-close:hover {
    color: var(--text);
  }

  .toast-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.375rem;
  }

  .toast-ticker {
    font-weight: 700;
    font-size: 1rem;
    color: var(--accent);
  }

  .toast-sentiment {
    font-size: 0.65rem;
    padding: 0.15rem 0.5rem;
  }

  .toast-title {
    font-size: 0.825rem;
    color: var(--text);
    line-height: 1.35;
    margin-bottom: 0.375rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .toast-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .toast-price {
    font-weight: 600;
    color: var(--text);
  }

  .toast-keywords {
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .toast-source {
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: var(--text-muted);
  }
</style>
