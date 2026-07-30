import WebSocket from 'ws'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443'
const BINANCE_REST_BASE = 'https://api.binance.com'

export interface ExecutionReport {
  e: 'executionReport'
  E: number
  s: string
  c: string
  S: 'BUY' | 'SELL'
  o: string
  q: string
  p: string
  P: string
  x: string
  X: string
  r: string
  i: number
  l: string
  z: string
  L: string
  n: string
  N: string | null
  T: number
  t: number
}

export interface TradeStreamData {
  e: 'trade'
  E: number
  s: string
  p: string
  q: string
  T: number
  m: boolean
}

type StreamName = 'prices' | 'userData'

class BinanceWebSocketService {
  private apiKey: string = ''

  private connections = new Map<StreamName, WebSocket>()
  private listenKey: string = ''
  private listenKeyTimer: ReturnType<typeof setInterval> | null = null

  private priceCache = new Map<string, { price: number; time: number }>()
  private subscribedSymbols = new Set<string>()

  private orderListeners = new Set<(report: ExecutionReport) => void>()
  private priceListeners = new Map<string, Set<(price: number) => void>>()
  private accountListeners = new Set<(data: any) => void>()

  private reconnectAttempts = new Map<StreamName, number>()
  private maxReconnectAttempts = 20
  private baseReconnectMs = 500

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async connectPrices(symbols: string[]): Promise<void> {
    this.apiKey = Env.get('BINANCE_API_KEY', '')

    for (const s of symbols) this.subscribedSymbols.add(s)
    this.connectStream('prices', this.buildPriceUrl())
  }

  public async connectUserData(): Promise<void> {
    this.apiKey = Env.get('BINANCE_API_KEY', '')

    if (!this.apiKey) {
      Logger.warn('[BinanceWS] API key missing, cannot connect user data stream')
      return
    }

    try {
      this.listenKey = await this.fetchListenKey()
      this.connectStream('userData', `${BINANCE_WS_BASE}/ws/${this.listenKey}`)
      this.startListenKeyRefresh()
    } catch (err) {
      Logger.error('[BinanceWS] Failed to get listen key: %s', err.message)
    }
  }

  public disconnect(): void {
    for (const [name, ws] of this.connections) {
      ws.close(1000, 'shutdown')
      Logger.debug('[BinanceWS] Closed %s stream', name)
    }
    this.connections.clear()
    if (this.listenKeyTimer) {
      clearInterval(this.listenKeyTimer)
      this.listenKeyTimer = null
    }
    this.reconnectAttempts.clear()
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions
  // ---------------------------------------------------------------------------

  public onOrderUpdate(cb: (report: ExecutionReport) => void): () => void {
    this.orderListeners.add(cb)
    return () => this.orderListeners.delete(cb)
  }

  public onPrice(symbol: string, cb: (price: number) => void): () => void {
    if (!this.priceListeners.has(symbol)) this.priceListeners.set(symbol, new Set())
    this.priceListeners.get(symbol)!.add(cb)
    return () => this.priceListeners.get(symbol)?.delete(cb)
  }

  public onAccountUpdate(cb: (data: any) => void): () => void {
    this.accountListeners.add(cb)
    return () => this.accountListeners.delete(cb)
  }

  // ---------------------------------------------------------------------------
  // Price cache
  // ---------------------------------------------------------------------------

  public getPrice(symbol: string): number | null {
    const cached = this.priceCache.get(symbol.toUpperCase())
    if (!cached) return null
    const staleMs = Date.now() - cached.time
    if (staleMs > 10000) return null
    return cached.price
  }

  public addSymbol(symbol: string): void {
    const s = symbol.toUpperCase()
    if (this.subscribedSymbols.has(s)) return
    this.subscribedSymbols.add(s)
    this.reconnectStream('prices')
  }

  public removeSymbol(symbol: string): void {
    const s = symbol.toUpperCase()
    this.subscribedSymbols.delete(s)
    this.reconnectStream('prices')
  }

  public getConnectedSymbols(): string[] {
    return [...this.subscribedSymbols]
  }

  // ---------------------------------------------------------------------------
  // Connection helpers
  // ---------------------------------------------------------------------------

  private connectStream(name: StreamName, url: string): void {
    const existing = this.connections.get(name)
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'reconnect')
    }

    Logger.debug('[BinanceWS] Connecting %s stream', name)
    const ws = new WebSocket(url)

    ws.on('open', () => {
      Logger.info('[BinanceWS] %s stream connected', name)
      this.reconnectAttempts.set(name, 0)
    })

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        this.handleMessage(name, msg)
      } catch { /* ignore parse errors */ }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      Logger.warn('[BinanceWS] %s stream closed (code=%d): %s', name, code, reason.toString())
      this.connections.delete(name)
      this.scheduleReconnect(name)
    })

    ws.on('error', (err: Error) => {
      Logger.error('[BinanceWS] %s stream error: %s', name, err.message)
    })

    this.connections.set(name, ws)
  }

  private scheduleReconnect(name: StreamName): void {
    const attempts = (this.reconnectAttempts.get(name) || 0) + 1
    this.reconnectAttempts.set(name, attempts)

    if (attempts > this.maxReconnectAttempts) {
      Logger.error('[BinanceWS] %s max reconnects reached', name)
      return
    }

    const delay = Math.min(this.baseReconnectMs * Math.pow(2, attempts - 1), 30000)
    Logger.info('[BinanceWS] Reconnecting %s in %dms (attempt %d)', name, delay, attempts)

    setTimeout(() => {
      if (name === 'prices') {
        this.connectStream('prices', this.buildPriceUrl())
      } else if (name === 'userData') {
        this.fetchListenKey()
          .then((key) => {
            this.listenKey = key
            this.connectStream('userData', `${BINANCE_WS_BASE}/ws/${key}`)
          })
          .catch(() => this.scheduleReconnect('userData'))
      }
    }, delay)
  }

  private reconnectStream(name: StreamName): void {
    const ws = this.connections.get(name)
    if (ws) ws.close(1000, 'reconnect')
  }

  private buildPriceUrl(): string {
    const streams: string[] = []
    for (const s of this.subscribedSymbols) {
      streams.push(`${s.toLowerCase()}usdt@trade`)
    }
    if (streams.length === 0) streams.push('btcusdt@trade')
    return `${BINANCE_WS_BASE}/stream?streams=${streams.join('/')}`
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(name: StreamName, msg: any): void {
    if (name === 'prices') {
      const data = msg.data || msg
      if (data.e === 'trade') {
        const symbol = data.s.replace('USDT', '').toUpperCase()
        this.priceCache.set(symbol, { price: parseFloat(data.p), time: data.E || Date.now() })
        const listeners = this.priceListeners.get(symbol)
        if (listeners) {
          const price = parseFloat(data.p)
          for (const cb of listeners) {
            try { cb(price) } catch { /* skip bad listener */ }
          }
        }
      }
    } else if (name === 'userData') {
      if (msg.e === 'executionReport') {
        for (const cb of this.orderListeners) {
          try { cb(msg as ExecutionReport) } catch { /* skip bad listener */ }
        }
      } else if (msg.e === 'outboundAccountPosition') {
        for (const cb of this.accountListeners) {
          try { cb(msg) } catch { /* skip bad listener */ }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Listen key management
  // ---------------------------------------------------------------------------

  private async fetchListenKey(): Promise<string> {
    const res = await fetch(`${BINANCE_REST_BASE}/api/v3/userDataStream`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': this.apiKey },
    })
    const json = await res.json()
    if (json.code && json.msg) throw new Error(json.msg)
    return json.listenKey
  }

  private async refreshListenKey(): Promise<void> {
    if (!this.listenKey) return
    try {
      const qs = new URLSearchParams({ listenKey: this.listenKey }).toString()
      await fetch(`${BINANCE_REST_BASE}/api/v3/userDataStream?${qs}`, {
        method: 'PUT',
        headers: { 'X-MBX-APIKEY': this.apiKey },
      })
    } catch (err) {
      Logger.warn('[BinanceWS] Listen key refresh failed: %s', err.message)
    }
  }

  private startListenKeyRefresh(): void {
    if (this.listenKeyTimer) clearInterval(this.listenKeyTimer)
    this.listenKeyTimer = setInterval(() => this.refreshListenKey(), 20 * 60 * 1000)
  }
}

export default new BinanceWebSocketService()
