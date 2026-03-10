type SSEListener = (data: any) => void;

const listeners = new Map<string, Set<SSEListener>>();
let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout>;
let started = false;

function connect() {
  if (typeof window === 'undefined') return;

  eventSource = new EventSource('/api/notifications/stream');

  eventSource.addEventListener('ticker_match', (e) => dispatch('ticker_match', JSON.parse(e.data)));
  eventSource.addEventListener('scrape_complete', (e) => dispatch('scrape_complete', JSON.parse(e.data)));
  eventSource.addEventListener('order_update', (e) => dispatch('order_update', JSON.parse(e.data)));
  eventSource.addEventListener('job_progress', (e) => dispatch('job_progress', JSON.parse(e.data)));
  eventSource.addEventListener('job_finished', (e) => dispatch('job_finished', JSON.parse(e.data)));

  eventSource.onerror = () => {
    eventSource?.close();
    reconnectTimer = setTimeout(connect, 5000);
  };
}

function dispatch(event: string, data: any) {
  listeners.get(event)?.forEach((fn) => fn(data));
}

function ensureStarted() {
  if (!started) {
    started = true;
    connect();
  }
}

export function onSSE(event: string, listener: SSEListener): () => void {
  ensureStarted();

  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)!.add(listener);

  return () => {
    listeners.get(event)?.delete(listener);
  };
}
