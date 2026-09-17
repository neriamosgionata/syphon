import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '$lib/api';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('API client', () => {
  describe('dashboard', () => {
    it('calls GET /api/dashboard', async () => {
      mockFetch.mockResolvedValue(mockResponse({ totalArticles: 10 }));
      const result = await api.dashboard();
      expect(mockFetch).toHaveBeenCalledWith('/api/dashboard', expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }));
      expect(result.totalArticles).toBe(10);
    });

    it('calls GET /api/jobs/active', async () => {
      mockFetch.mockResolvedValue(mockResponse({ jobs: [{ id: '1', queue: 'scrape-news' }] }));
      const result = await api.activeJobs();
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs/active', expect.anything());
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].queue).toBe('scrape-news');
    });

    it('calls GET /api/jobs/failed', async () => {
      mockFetch.mockResolvedValue(mockResponse({ jobs: [{ id: '5', failedReason: 'timeout' }] }));
      const result = await api.failedJobs();
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs/failed', expect.anything());
      expect(result.jobs[0].failedReason).toBe('timeout');
    });

    it('calls GET /api/jobs/failed with limit', async () => {
      mockFetch.mockResolvedValue(mockResponse({ jobs: [] }));
      await api.failedJobs(10);
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs/failed?limit=10', expect.anything());
    });

    it('calls POST /api/jobs/:queue/:id/retry', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'Job queued for retry' }));
      await api.retryJob('scrape-news', '42');
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs/scrape-news/42/retry', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('calls DELETE /api/jobs/:queue/:id', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'Job removed' }));
      await api.removeFailedJob('fetch-ticker', '99');
      expect(mockFetch).toHaveBeenCalledWith('/api/jobs/fetch-ticker/99', expect.objectContaining({
        method: 'DELETE',
      }));
    });
  });

  describe('articles', () => {
    it('calls GET /api/articles with no params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ data: [], meta: {} }));
      await api.articles();
      expect(mockFetch).toHaveBeenCalledWith('/api/articles', expect.anything());
    });

    it('calls GET /api/articles with query params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ data: [], meta: {} }));
      await api.articles({ page: '2', limit: '10' });
      expect(mockFetch).toHaveBeenCalledWith('/api/articles?page=2&limit=10', expect.anything());
    });

    it('calls GET /api/articles/:id', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 5 }));
      const result = await api.article(5);
      expect(mockFetch).toHaveBeenCalledWith('/api/articles/5', expect.anything());
      expect(result.id).toBe(5);
    });

    it('calls GET /api/articles/search with params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ hits: [] }));
      await api.searchArticles({ q: 'test', ticker: 'AAPL' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/articles/search?'),
        expect.anything()
      );
    });

    it('calls GET /api/articles/sources', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await api.sources();
      expect(mockFetch).toHaveBeenCalledWith('/api/articles/sources', expect.anything());
    });

    it('calls POST /api/articles/scrape', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'ok' }));
      await api.triggerScrape(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/articles/scrape', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source_id: 1 }),
      }));
    });

    it('calls POST /api/articles/analyze', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'ok' }));
      await api.triggerAnalysis(50);
      expect(mockFetch).toHaveBeenCalledWith('/api/articles/analyze', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ limit: 50 }),
      }));
    });
  });

  describe('tickers', () => {
    it('calls GET /api/tickers', async () => {
      mockFetch.mockResolvedValue(mockResponse({ data: [] }));
      await api.tickers();
      expect(mockFetch).toHaveBeenCalledWith('/api/tickers', expect.anything());
    });

    it('calls GET /api/tickers/:symbol', async () => {
      mockFetch.mockResolvedValue(mockResponse({ symbol: 'AAPL' }));
      await api.ticker('AAPL');
      expect(mockFetch).toHaveBeenCalledWith('/api/tickers/AAPL', expect.anything());
    });

    it('calls GET /api/tickers/search with encoded query', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await api.searchTickers('Apple Inc');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/tickers/search?q=Apple%20Inc',
        expect.anything()
      );
    });

    it('calls POST /api/tickers', async () => {
      mockFetch.mockResolvedValue(mockResponse({ symbol: 'AAPL' }));
      await api.addTicker('AAPL');
      expect(mockFetch).toHaveBeenCalledWith('/api/tickers', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL' }),
      }));
    });

    it('calls POST /api/tickers/:symbol/refresh', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'ok' }));
      await api.refreshTicker('AAPL');
      expect(mockFetch).toHaveBeenCalledWith('/api/tickers/AAPL/refresh', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('calls DELETE /api/tickers/:symbol', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'ok' }));
      await api.removeTicker('AAPL');
      expect(mockFetch).toHaveBeenCalledWith('/api/tickers/AAPL', expect.objectContaining({
        method: 'DELETE',
      }));
    });
  });

  describe('analysis', () => {
    it('calls GET /api/analysis', async () => {
      mockFetch.mockResolvedValue(mockResponse({ data: [] }));
      await api.analyses();
      expect(mockFetch).toHaveBeenCalledWith('/api/analysis', expect.anything());
    });

    it('calls GET /api/analysis/:id', async () => {
      mockFetch.mockResolvedValue(mockResponse({ id: 1 }));
      await api.analysis(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/analysis/1', expect.anything());
    });

    it('calls GET /api/analysis/stats', async () => {
      mockFetch.mockResolvedValue(mockResponse({ byTicker: [] }));
      await api.analysisStats();
      expect(mockFetch).toHaveBeenCalledWith('/api/analysis/stats', expect.anything());
    });

    it('calls GET /api/analysis/timeline with params', async () => {
      mockFetch.mockResolvedValue(mockResponse([]));
      await api.analysisTimeline('AAPL', 7);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/analysis/timeline?ticker=AAPL&days=7',
        expect.anything()
      );
    });
  });

  describe('trading', () => {
    it('calls GET /api/trading/status', async () => {
      mockFetch.mockResolvedValue(mockResponse({ connection: { connected: false } }));
      await api.tradingStatus();
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/status', expect.anything());
    });

    it('calls POST /api/trading/connect with default broker', async () => {
      mockFetch.mockResolvedValue(mockResponse({ connected: true }));
      await api.tradingConnect();
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/connect', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ broker: 'ibkr' }),
      }));
    });

    it('calls POST /api/trading/connect with kraken broker', async () => {
      mockFetch.mockResolvedValue(mockResponse({ connected: true }));
      await api.tradingConnect('kraken');
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/connect', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ broker: 'kraken' }),
      }));
    });

    it('calls POST /api/trading/disconnect with default broker', async () => {
      mockFetch.mockResolvedValue(mockResponse({ connected: false }));
      await api.tradingDisconnect();
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/disconnect', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ broker: 'ibkr' }),
      }));
    });

    it('calls POST /api/trading/disconnect with kraken broker', async () => {
      mockFetch.mockResolvedValue(mockResponse({ connected: false }));
      await api.tradingDisconnect('kraken');
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/disconnect', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ broker: 'kraken' }),
      }));
    });

    it('calls POST /api/trading/orders with order data', async () => {
      mockFetch.mockResolvedValue(mockResponse({ trade: {}, message: 'ok' }));
      await api.placeOrder({
        symbol: 'AAPL',
        side: 'BUY',
        order_type: 'MKT',
        quantity: 10,
      });
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/orders', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          symbol: 'AAPL',
          side: 'BUY',
          order_type: 'MKT',
          quantity: 10,
        }),
      }));
    });

    it('calls POST /api/trading/orders/:id/cancel', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'ok' }));
      await api.cancelOrder(5);
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/orders/5/cancel', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('calls GET /api/trading/stats with optional symbol', async () => {
      mockFetch.mockResolvedValue(mockResponse({ overview: {} }));
      await api.tradingStats('AAPL');
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/stats?symbol=AAPL', expect.anything());
    });

    it('calls GET /api/trading/stats without symbol', async () => {
      mockFetch.mockResolvedValue(mockResponse({ overview: {} }));
      await api.tradingStats();
      expect(mockFetch).toHaveBeenCalledWith('/api/trading/stats', expect.anything());
    });
  });

  describe('signals', () => {
    it('calls GET /api/signals with no params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ generated_at: '', count: 0, signals: [] }));
      await api.signals();
      expect(mockFetch).toHaveBeenCalledWith('/api/signals', expect.anything());
    });

    it('calls GET /api/signals with query params', async () => {
      mockFetch.mockResolvedValue(mockResponse({ generated_at: '', count: 0, signals: [] }));
      await api.signals({ days: '7', min_articles: '3' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/signals?days=7&min_articles=3',
        expect.anything()
      );
    });
  });

  describe('prune', () => {
    it('calls POST /api/prune', async () => {
      mockFetch.mockResolvedValue(mockResponse({ message: 'ok', deleted: {} }));
      await api.pruneDatabase();
      expect(mockFetch).toHaveBeenCalledWith('/api/prune', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  describe('logs', () => {
    it('calls GET /api/logs', async () => {
      mockFetch.mockResolvedValue(mockResponse({ hits: [] }));
      await api.logs({ level: 'error' });
      expect(mockFetch).toHaveBeenCalledWith('/api/logs?level=error', expect.anything());
    });

    it('calls GET /api/logs/stats', async () => {
      mockFetch.mockResolvedValue(mockResponse({}));
      await api.logStats();
      expect(mockFetch).toHaveBeenCalledWith('/api/logs/stats', expect.anything());
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response with error message', async () => {
      mockFetch.mockResolvedValue(mockResponse({ error: 'Not found' }, 404));
      await expect(api.dashboard()).rejects.toThrow('Not found');
    });

    it('throws generic message when no error in body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('parse error')),
      });
      await expect(api.dashboard()).rejects.toThrow('Request failed: 500');
    });
  });
});

describe('income lines', () => {
  it('calls GET /api/yield/status', async () => {
    mockFetch.mockResolvedValue(mockResponse({ allocations: [], lastTick: { stale: true } }));
    const result = await api.yieldStatus();
    expect(mockFetch).toHaveBeenCalledWith('/api/yield/status', expect.anything());
    expect(result.allocations).toEqual([]);
  });

  it('calls GET /api/yield/alerts', async () => {
    mockFetch.mockResolvedValue(mockResponse({ alerts: [{ code: 'tripwire' }] }));
    const result = await api.yieldAlerts();
    expect(mockFetch).toHaveBeenCalledWith('/api/yield/alerts', expect.anything());
    expect(result.alerts[0].code).toBe('tripwire');
  });

  it('calls GET /api/trend/status', async () => {
    mockFetch.mockResolvedValue(mockResponse({ trip: { state: 'ok' }, evaluations: [] }));
    const result = await api.trendStatus();
    expect(mockFetch).toHaveBeenCalledWith('/api/trend/status', expect.anything());
    expect(result.trip.state).toBe('ok');
  });
});
