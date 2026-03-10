import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock EventSource before importing the module
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, Function> = {};
  onerror: Function | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, handler: Function) {
    this.listeners[event] = handler;
  }

  close() {
    this.closed = true;
  }

  simulateEvent(event: string, data: any) {
    if (this.listeners[event]) {
      this.listeners[event]({ data: JSON.stringify(data) });
    }
  }

  simulateError() {
    if (this.onerror) this.onerror();
  }
}

vi.stubGlobal('EventSource', MockEventSource);

describe('SSE client', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    // Reset module state by re-importing
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects to /api/notifications/stream on first subscribe', async () => {
    const { onSSE } = await import('$lib/sse');
    onSSE('ticker_match', () => {});
    expect(MockEventSource.instances.length).toBeGreaterThan(0);
    expect(MockEventSource.instances[0].url).toBe('/api/notifications/stream');
  });

  it('dispatches ticker_match events to listeners', async () => {
    const { onSSE } = await import('$lib/sse');
    const received: any[] = [];
    onSSE('ticker_match', (data) => received.push(data));

    const es = MockEventSource.instances[0];
    es.simulateEvent('ticker_match', { symbol: 'AAPL', sentiment: 'bullish' });

    expect(received).toHaveLength(1);
    expect(received[0].symbol).toBe('AAPL');
  });

  it('dispatches scrape_complete events', async () => {
    const { onSSE } = await import('$lib/sse');
    const received: any[] = [];
    onSSE('scrape_complete', (data) => received.push(data));

    const es = MockEventSource.instances[0];
    es.simulateEvent('scrape_complete', { totalSaved: 5 });

    expect(received).toHaveLength(1);
    expect(received[0].totalSaved).toBe(5);
  });

  it('dispatches order_update events', async () => {
    const { onSSE } = await import('$lib/sse');
    const received: any[] = [];
    onSSE('order_update', (data) => received.push(data));

    const es = MockEventSource.instances[0];
    es.simulateEvent('order_update', { tradeId: 1, status: 'filled' });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('filled');
  });

  it('returns unsubscribe function that stops events', async () => {
    const { onSSE } = await import('$lib/sse');
    const received: any[] = [];
    const unsub = onSSE('ticker_match', (data) => received.push(data));

    const es = MockEventSource.instances[0];
    es.simulateEvent('ticker_match', { id: 1 });
    expect(received).toHaveLength(1);

    unsub();
    es.simulateEvent('ticker_match', { id: 2 });
    expect(received).toHaveLength(1);
  });

  it('only creates one EventSource connection', async () => {
    const { onSSE } = await import('$lib/sse');
    onSSE('ticker_match', () => {});
    onSSE('scrape_complete', () => {});
    onSSE('order_update', () => {});
    // Should reuse the same connection
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('multiple listeners for same event all receive data', async () => {
    const { onSSE } = await import('$lib/sse');
    const r1: any[] = [];
    const r2: any[] = [];
    onSSE('ticker_match', (d) => r1.push(d));
    onSSE('ticker_match', (d) => r2.push(d));

    const es = MockEventSource.instances[0];
    es.simulateEvent('ticker_match', { test: true });

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('dispatches job_progress events', async () => {
    const { onSSE } = await import('$lib/sse');
    const received: any[] = [];
    onSSE('job_progress', (data) => received.push(data));

    const es = MockEventSource.instances[0];
    es.simulateEvent('job_progress', {
      queue: 'scrape-news',
      jobId: '42',
      progress: 60,
      stage: 'Scraping Reuters',
    });

    expect(received).toHaveLength(1);
    expect(received[0].queue).toBe('scrape-news');
    expect(received[0].progress).toBe(60);
    expect(received[0].stage).toBe('Scraping Reuters');
  });

  it('dispatches job_finished events', async () => {
    const { onSSE } = await import('$lib/sse');
    const received: any[] = [];
    onSSE('job_finished', (data) => received.push(data));

    const es = MockEventSource.instances[0];
    es.simulateEvent('job_finished', {
      queue: 'fetch-ticker',
      jobId: '99',
      status: 'completed',
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('completed');
    expect(received[0].jobId).toBe('99');
  });
});
