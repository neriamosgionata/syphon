import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import NotificationToast from '../NotificationToast.svelte';

afterEach(() => cleanup());

let onSSECallback: ((data: any) => void) | null = null;

vi.mock('$lib/sse', () => ({
  onSSE: vi.fn((_event: string, cb: (data: any) => void) => {
    onSSECallback = cb;
    return () => {};
  }),
}));

import { onSSE } from '$lib/sse';

const notification = {
  type: 'ticker_match',
  articleId: 1,
  articleTitle: 'Apple earnings beat estimates',
  articleUrl: 'https://example.com/a',
  sourceName: 'CNBC',
  ticker: { symbol: 'AAPL', name: 'Apple Inc', currentPrice: 210.5 },
  sentiment: 'bullish',
  sentimentScore: 0.72,
  relevanceScore: 0.9,
  confidence: 0.85,
  keywords: ['earnings', 'iphone', 'revenue', 'growth', 'extra'],
  timestamp: new Date().toISOString(),
};

beforeEach(() => {
  onSSECallback = null;
  vi.mocked(onSSE).mockClear();
});

describe('NotificationToast', () => {
  it('renders nothing without notifications', () => {
    const { container } = render(NotificationToast);
    expect(container.querySelector('.toast-container')).toBeNull();
  });

  it('subscribes to the ticker_match SSE channel on mount', () => {
    render(NotificationToast);
    expect(onSSE).toHaveBeenCalledWith('ticker_match', expect.any(Function));
  });

  it('shows a toast when a notification arrives', async () => {
    render(NotificationToast);
    onSSECallback?.(notification);
    await tick();

    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Bullish')).toBeInTheDocument();
    expect(screen.getByText('Apple earnings beat estimates')).toBeInTheDocument();
    expect(screen.getByText('CNBC')).toBeInTheDocument();
  });

  it('formats price, score and confidence', async () => {
    render(NotificationToast);
    onSSECallback?.(notification);
    await tick();

    expect(screen.getByText('$210.50')).toBeInTheDocument();
    expect(screen.getByText('Score: 0.720')).toBeInTheDocument();
    expect(screen.getByText('Conf: 85%')).toBeInTheDocument();
  });

  it('shows up to 4 keywords', async () => {
    render(NotificationToast);
    onSSECallback?.(notification);
    await tick();

    expect(screen.getByText('earnings, iphone, revenue, growth')).toBeInTheDocument();
  });

  it('hides price when currentPrice is null', async () => {
    render(NotificationToast);
    onSSECallback?.({ ...notification, ticker: { ...notification.ticker, currentPrice: null } });
    await tick();

    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('hides source when absent', async () => {
    render(NotificationToast);
    onSSECallback?.({ ...notification, sourceName: null });
    await tick();

    expect(screen.queryByText('CNBC')).toBeNull();
  });

  it('hides keywords when empty', async () => {
    const { container } = render(NotificationToast);
    onSSECallback?.({ ...notification, keywords: [] });
    await tick();

    expect(container.querySelector('.toast-keywords')).toBeNull();
  });

  it('falls back to the raw sentiment label for unknown sentiments', async () => {
    render(NotificationToast);
    onSSECallback?.({ ...notification, sentiment: 'mooning' });
    await tick();

    expect(screen.getByText('mooning')).toBeInTheDocument();
  });

  it('dismisses a toast via the close button', async () => {
    render(NotificationToast);
    onSSECallback?.(notification);
    await tick();

    const close = document.querySelector('.toast-close') as HTMLButtonElement;
    expect(close).not.toBeNull();
    fireEvent.click(close);

    // Dismissal is animated (300ms) before removal
    await new Promise((r) => setTimeout(r, 400));
    expect(document.querySelector('.toast-container')).toBeNull();
  });
});
