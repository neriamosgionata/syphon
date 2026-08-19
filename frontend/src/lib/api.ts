const BASE = '/api';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Dashboard
  dashboard: () => request<any>('/dashboard'),
  activeJobs: () => request<any>('/jobs/active'),
  failedJobs: (limit?: number) => request<any>(`/jobs/failed${limit ? `?limit=${limit}` : ''}`),
  retryJob: (queue: string, id: string) =>
    request<any>(`/jobs/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  removeFailedJob: (queue: string, id: string) =>
    request<any>(`/jobs/${encodeURIComponent(queue)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  cancelJob: (queue: string, id: string) =>
    request<any>(`/jobs/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  drainQueues: () => request<any>('/jobs/drain', { method: 'POST' }),
  pruneDatabase: () => request<any>('/prune', { method: 'POST' }),

  // Articles
  articles: (params?: Record<string, any>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/articles${qs ? `?${qs}` : ''}`);
  },
  article: (id: number) => request<any>(`/articles/${id}`),
  searchArticles: (params: Record<string, any>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/articles/search?${qs}`);
  },
  sources: () => request<any[]>('/articles/sources'),
  triggerScrape: (sourceId?: number) =>
    request<any>('/articles/scrape', {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId }),
    }),
  triggerAnalysis: (limit?: number) =>
    request<any>('/articles/analyze', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  backfillNews: (params?: { symbol?: string; days?: number }) =>
    request<any>('/articles/backfill', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    }),

  // Tickers
  tickers: (params?: Record<string, any>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/tickers${qs ? `?${qs}` : ''}`);
  },
  ticker: (symbol: string) => request<any>(`/tickers/${symbol}`),
  searchTickers: (q: string) => request<any[]>(`/tickers/search?q=${encodeURIComponent(q)}`),
  addTicker: (symbol: string) =>
    request<any>('/tickers', { method: 'POST', body: JSON.stringify({ symbol }) }),
  refreshTicker: (symbol: string) =>
    request<any>(`/tickers/${symbol}/refresh`, { method: 'POST' }),
  refreshAllTickers: () =>
    request<any>('/tickers/refresh-all', { method: 'POST' }),
  backfillTickers: (params?: { symbol?: string; days?: number }) =>
    request<any>('/tickers/backfill', { method: 'POST', body: JSON.stringify(params || {}) }),
  removeTicker: (symbol: string) =>
    request<any>(`/tickers/${symbol}`, { method: 'DELETE' }),

  // Analysis
  analyses: (params?: Record<string, any>) => {
    const qs = new URLSearchParams(params).toString();
    return request<any>(`/analysis${qs ? `?${qs}` : ''}`);
  },
  analysis: (id: number) => request<any>(`/analysis/${id}`),
  analysisStats: () => request<any>('/analysis/stats'),
  analysisTimeline: (ticker: string, days?: number) =>
    request<any[]>(`/analysis/timeline?ticker=${ticker}&days=${days || 30}`),

  // Trading
  tradingStatus: () => request<any>('/trading/status'),
  tradingConnect: (broker: string = 'ibkr') =>
    request<any>('/trading/connect', { method: 'POST', body: JSON.stringify({ broker }) }),
  tradingDisconnect: (broker: string = 'ibkr') =>
    request<any>('/trading/disconnect', { method: 'POST', body: JSON.stringify({ broker }) }),
  tradingAccount: () => request<any>('/trading/account'),
  tradingPositions: () => request<any[]>('/trading/positions'),
  tradingStats: (symbol?: string) => {
    const qs = symbol ? `?symbol=${symbol}` : '';
    return request<any>(`/trading/stats${qs}`);
  },
  tradingOrders: (params?: Record<string, any>) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request<any>(`/trading/orders${qs ? `?${qs}` : ''}`);
  },
  tradingOrder: (id: number) => request<any>(`/trading/orders/${id}`),
  placeOrder: (order: {
    symbol: string;
    side: 'BUY' | 'SELL';
    order_type: string;
    quantity: number;
    limit_price?: number;
    stop_price?: number;
    trail_amount?: number;
    time_in_force?: string;
    exchange?: string;
    currency?: string;
    analysis_id?: number;
    broker?: string;
  }) =>
    request<any>('/trading/orders', {
      method: 'POST',
      body: JSON.stringify(order),
    }),
  cancelOrder: (id: number) =>
    request<any>(`/trading/orders/${id}/cancel`, { method: 'POST' }),

  // Quant (unified engine — includes signals)
  quantAnalyze: (symbol: string) => request<any>(`/quant/${encodeURIComponent(symbol)}`),
  quantScreener: (params?: Record<string, any>) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request<any>(`/quant/screener${qs ? `?${qs}` : ''}`);
  },

  // Signals (legacy — delegates to quant engine)
  signals: (params?: Record<string, any>) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request<any>(`/signals${qs ? `?${qs}` : ''}`);
  },

  // Algo Trading
  algoConfig: () => request<any>('/algo/config'),
  algoUpdateConfig: (config: Record<string, any>) =>
    request<any>('/algo/config', { method: 'PUT', body: JSON.stringify(config) }),
  algoEnable: () => request<any>('/algo/enable', { method: 'POST' }),
  algoDisable: () => request<any>('/algo/disable', { method: 'POST' }),
  algoFastStatus: () => request<any>('/algo/fast/status'),
  algoDecisions: (params?: Record<string, any>) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request<any>(`/algo/decisions${qs ? `?${qs}` : ''}`);
  },
  algoPositions: (params?: Record<string, any>) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request<any>(`/algo/positions${qs ? `?${qs}` : ''}`);
  },
  algoForceClose: (id: number) =>
    request<any>(`/algo/positions/${id}/close`, { method: 'POST' }),
  algoStats: () => request<any>('/algo/stats'),

  // Training (NN model service)
  trainingHealth: () => request<any>('/training/health'),
  trainingConfig: () => request<any>('/training/config'),
  trainingModel: () => request<any>('/training/model'),
  trainingPredict: (pair: string) =>
    request<any>('/training/predict', { method: 'POST', body: JSON.stringify({ pair }) }),
  trainingPredictBatch: (pairs: string[]) =>
    request<any>('/training/predict/batch', { method: 'POST', body: JSON.stringify({ pairs }) }),
  trainingStart: (params?: { pairs?: string[]; epochs?: number; batch_size?: number; learning_rate?: number }) =>
    request<any>('/training/train', { method: 'POST', body: JSON.stringify(params || {}) }),
  trainingStatus: () => request<any>('/training/train/status'),
  trainingBackfill: (params?: { pairs?: string[]; days?: number }) =>
    request<any>('/training/backfill', { method: 'POST', body: JSON.stringify(params || {}) }),
  trainingBackfillStatus: () => request<any>('/training/backfill/status'),

  // Metrics
  metrics: () => request<any>('/metrics'),

  // Logs
  logs: (params?: Record<string, any>) => {
    const qs = params ? new URLSearchParams(params).toString() : '';
    return request<any>(`/logs${qs ? `?${qs}` : ''}`);
  },
  logStats: () => request<any>('/logs/stats'),
};
