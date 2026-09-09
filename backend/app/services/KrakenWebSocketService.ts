import WebSocket from 'ws'
import crypto from 'crypto'
import querystring from 'querystring'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'

const KRAKEN_WS_BASE = 'wss://ws.kraken.com'
const KRAKEN_WS_AUTH_BASE = 'wss://ws-auth.kraken.com'
const KRAKEN_REST_BASE = 'https://api.kraken.com'

export interface KrakenOrderUpdate {
  txid: string
  cl_ord_id?: string
  userref?: number
  status?: string
  vol?: string
  vol_exec?: string
  cost?: string
  fee?: string
  avg_price?: string
  lastupdated?: string
  descr?: { pair?: string }
}

export interface KrakenWSTrade {
  /** App symbol (BTC, not XBT). */
  symbol: string
  price: number
  volume: number
  /** Epoch seconds. */
  time: number
  side: 'buy' | 'sell'
  ordertype: 'market' | 'limit'
}

function getKrakenSignature(urlPath: string, data: Record<string, any>, secret: string): string {
  const dataStr = querystring.stringify(data)
  const encoded = data.nonce + dataStr
  const sha256Hash = crypto.createHash('sha256').update(encoded).digest()
  const message = Buffer.concat([Buffer.from(urlPath), sha256Hash])
  const secretBuffer = Buffer.from(secret, 'base64')
  return crypto.createHmac('sha512', secretBuffer).update(message).digest('base64')
}

// Kraken uses XBT instead of BTC in pair names (both REST and WS).
function toWsPair(symbol: string, currency = 'USD'): string {
  const base = symbol.toUpperCase() === 'BTC' ? 'XBT' : symbol.toUpperCase()
  return `${base}/${currency.toUpperCase()}`
}

function fromWsPair(pair: string): string {
  const base = pair.split('/')[0]?.toUpperCase() || ''
  return base === 'XBT' ? 'BTC' : base
}

type StreamName = 'prices' | 'userData' | 'trades'

class KrakenWebSocketService {
  private apiKey: string = ''
  private apiSecret: string = ''
  private lastNonce = 0

  private connections = new Map<StreamName, WebSocket>()
  private token: string = ''
  private tokenTimer: ReturnType<typeof setInterval> | null = null

  private priceCache = new Map<string, { price: number; time: number }>()
  private subscribedSymbols = new Set<string>()

  private orderListeners = new Set<(update: KrakenOrderUpdate) => void>()
  private priceListeners = new Map<string, Set<(price: number) => void>>()
  private tradeListeners = new Map<string, Set<(trade: KrakenWSTrade) => void>>()
  private tradeSymbols = new Set<string>()

  private reconnectAttempts = new Map<StreamName, number>()
  private reconnectTimers = new Map<StreamName, ReturnType<typeof setTimeout>>()
  private maxReconnectAttempts = 20
  private baseReconnectMs = 500
  private intentionalCloses = new Set<WebSocket>()

  // Kraken requires strictly increasing nonces per API key.
  private nextNonce(): number {
    const base = Date.now() * 1000
    this.lastNonce = Math.max(base, this.lastNonce + 1)
    return this.lastNonce
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async connectPrices(symbols: string[]): Promise<void> {
    this.apiKey = env.get('KRAKEN_API_KEY', '')
    this.apiSecret = env.get('KRAKEN_API_SECRET', '')

    for (const s of symbols) this.subscribedSymbols.add(s)
    this.connectStream('prices', KRAKEN_WS_BASE)
  }

  public async connectUserData(): Promise<void> {
    this.apiKey = env.get('KRAKEN_API_KEY', '')
    this.apiSecret = env.get('KRAKEN_API_SECRET', '')

    if (!this.apiKey || !this.apiSecret) {
      logger.warn('[KrakenWS] API key missing, cannot connect user data stream')
      return
    }

    try {
      this.token = await this.fetchToken()
      this.connectStream('userData', KRAKEN_WS_AUTH_BASE)
      this.startTokenRefresh()
    } catch (err) {
      logger.error('[KrakenWS] Failed to get WS token: %s', (err as Error).message)
    }
  }

  public disconnect(): void {
    for (const [name, ws] of this.connections) {
      this.closeIntentionally(ws, 1000, 'shutdown')
      logger.debug('[KrakenWS] Closed %s stream', name)
    }
    this.connections.clear()
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    if (this.tokenTimer) {
      clearInterval(this.tokenTimer)
      this.tokenTimer = null
    }
    this.reconnectAttempts.clear()
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions
  // ---------------------------------------------------------------------------

  public onOrderUpdate(cb: (update: KrakenOrderUpdate) => void): () => void {
    this.orderListeners.add(cb)
    return () => this.orderListeners.delete(cb)
  }

  public onPrice(symbol: string, cb: (price: number) => void): () => void {
    if (!this.priceListeners.has(symbol)) this.priceListeners.set(symbol, new Set())
    this.priceListeners.get(symbol)!.add(cb)
    return () => this.priceListeners.get(symbol)?.delete(cb)
  }

  // ── Trade stream (1s-bar recording / backtest data) ─────────

  /** Subscribe a symbol's public trade channel. Reconnects the trades stream. */
  public addTradeSymbol(symbol: string): void {
    const s = symbol.toUpperCase()
    if (this.tradeSymbols.has(s)) return
    this.tradeSymbols.add(s)
    this.connectStream('trades', KRAKEN_WS_BASE)
  }

  public onTrade(symbol: string, cb: (trade: KrakenWSTrade) => void): () => void {
    if (!this.tradeListeners.has(symbol)) this.tradeListeners.set(symbol, new Set())
    this.tradeListeners.get(symbol)!.add(cb)
    return () => this.tradeListeners.get(symbol)?.delete(cb)
  }

  public getTradeSymbols(): string[] {
    return [...this.tradeSymbols]
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

  private closeIntentionally(ws: WebSocket | undefined, code = 1000, reason = 'reconnect'): void {
    if (!ws) return
    this.intentionalCloses.add(ws)
    try {
      ws.close(code, reason)
    } catch { /* socket already closing */ }
  }

  private connectStream(name: StreamName, url: string): void {
    const existing = this.connections.get(name)
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      this.closeIntentionally(existing)
    }

    // No real sockets in the test environment: subscribing must not make
    // outbound network calls (or spin up the reconnect loop) mid-suite. The
    // in-memory subscription state is still tracked so `getConnectedSymbols`
    // and the price cache behave as usual.
    if (env.get('NODE_ENV') === 'test') {
      logger.debug('[KrakenWS] Skipping %s stream connection in test env', name)
      this.connections.delete(name)
      return
    }

    logger.debug('[KrakenWS] Connecting %s stream', name)
    const ws = new WebSocket(url)

    ws.on('open', () => {
      logger.info('[KrakenWS] %s stream connected', name)
      this.reconnectAttempts.set(name, 0)
      this.subscribe(name, ws)
    })

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        this.handleMessage(name, msg)
      } catch { /* ignore parse errors */ }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      logger.warn('[KrakenWS] %s stream closed (code=%d): %s', name, code, reason.toString())
      const intentional = this.intentionalCloses.delete(ws)
      if (this.connections.get(name) === ws) this.connections.delete(name)
      if (!intentional) this.scheduleReconnect(name)
    })

    ws.on('error', (err: Error) => {
      logger.error('[KrakenWS] %s stream error: %s', name, (err as Error).message)
    })

    this.connections.set(name, ws)
  }

  private subscribe(name: StreamName, ws: WebSocket): void {
    try {
      if (name === 'prices') {
        const pairs = [...this.subscribedSymbols].map((s) => toWsPair(s))
        if (pairs.length === 0) pairs.push('XBT/USD')
        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: pairs,
          subscription: { name: 'ticker' },
        }))
      } else if (name === 'userData') {
        ws.send(JSON.stringify({
          event: 'subscribe',
          subscription: { name: 'openOrders', token: this.token },
        }))
      } else if (name === 'trades') {
        const pairs = [...this.tradeSymbols].map((s) => toWsPair(s))
        if (pairs.length === 0) pairs.push('XBT/USD')
        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: pairs,
          subscription: { name: 'trade' },
        }))
      }
    } catch (err) {
      logger.warn('[KrakenWS] Subscribe to %s failed: %s', name, (err as Error).message)
    }
  }

  private scheduleReconnect(name: StreamName): void {
    const attempts = (this.reconnectAttempts.get(name) || 0) + 1
    this.reconnectAttempts.set(name, attempts)

    if (attempts > this.maxReconnectAttempts) {
      logger.error('[KrakenWS] %s max reconnects reached', name)
      return
    }

    const delay = Math.min(this.baseReconnectMs * Math.pow(2, attempts - 1), 30000)
    logger.info('[KrakenWS] Reconnecting %s in %dms (attempt %d)', name, delay, attempts)

    const existing = this.reconnectTimers.get(name)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name)
      if (name === 'prices') {
        this.connectStream('prices', KRAKEN_WS_BASE)
      } else if (name === 'userData') {
        // Tokens expire after 15 minutes — fetch a fresh one before rejoining.
        this.fetchToken()
          .then((t) => {
            this.token = t
            this.connectStream('userData', KRAKEN_WS_AUTH_BASE)
          })
          .catch(() => this.scheduleReconnect('userData'))
      } else if (name === 'trades') {
        this.connectStream('trades', KRAKEN_WS_BASE)
      }
    }, delay)
    this.reconnectTimers.set(name, timer)
  }

  private reconnectStream(name: StreamName): void {
    if (name === 'prices') this.connectStream('prices', KRAKEN_WS_BASE)
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(name: StreamName, msg: any): void {
    if (name === 'prices') {
      // V1 ticker: [channelID, tickerObj, "ticker", "XBT/USD"]
      if (Array.isArray(msg) && msg[2] === 'ticker' && msg[3]) {
        const symbol = fromWsPair(msg[3])
        const price = parseFloat(msg[1]?.c?.[0])
        if (Number.isFinite(price) && price > 0) {
          this.priceCache.set(symbol, { price, time: Date.now() })
          const listeners = this.priceListeners.get(symbol)
          if (listeners) {
            for (const cb of listeners) {
              try { cb(price) } catch { /* skip bad listener */ }
            }
          }
        }
      }
    } else if (name === 'userData') {
      // V1 openOrders: [ [{ "<txid>": { ... } }], "openOrders", { sequence } ]
      if (Array.isArray(msg) && msg[1] === 'openOrders' && Array.isArray(msg[0])) {
        for (const o of msg[0]) {
          const txid = Object.keys(o)[0]
          if (!txid) continue
          const update: KrakenOrderUpdate = { txid, ...o[txid] }
          for (const cb of this.orderListeners) {
            try { cb(update) } catch { /* skip bad listener */ }
          }
        }
      }
    } else if (name === 'trades') {
      // V1 trade: [channelID, [[price, volume, time, buy/sell, market/limit, misc], ...], "trade", "XBT/USD"]
      if (Array.isArray(msg) && msg[2] === 'trade' && msg[3] && Array.isArray(msg[1])) {
        const symbol = fromWsPair(msg[3])
        const listeners = this.tradeListeners.get(symbol)
        if (!listeners) return
        for (const row of msg[1]) {
          const price = parseFloat(row?.[0])
          const volume = parseFloat(row?.[1])
          const time = parseFloat(row?.[2])
          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) continue
          const trade: KrakenWSTrade = {
            symbol,
            price,
            volume: Number.isFinite(volume) ? volume : 0,
            time,
            side: row[3] === 'b' ? 'buy' : 'sell',
            ordertype: row[4] === 'l' ? 'limit' : 'market',
          }
          for (const cb of listeners) {
            try { cb(trade) } catch { /* skip bad listener */ }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket token management (15-minute expiry)
  // ---------------------------------------------------------------------------

  private async fetchToken(): Promise<string> {
    const nonce = this.nextNonce()
    const body = { nonce }
    const signature = getKrakenSignature('/0/private/GetWebSocketsToken', body, this.apiSecret)

    const res = await fetch(`${KRAKEN_REST_BASE}/0/private/GetWebSocketsToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': this.apiKey,
        'API-Sign': signature,
      },
      body: querystring.stringify(body),
    })

    const json: any = await res.json()
    if (json.error && json.error.length > 0) {
      throw new Error(json.error.join('; '))
    }
    return json.result?.token
  }

  private async refreshToken(): Promise<void> {
    try {
      this.token = await this.fetchToken()
      const ws = this.connections.get('userData')
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'subscribe',
          subscription: { name: 'openOrders', token: this.token },
        }))
      }
    } catch (err) {
      logger.warn('[KrakenWS] Token refresh failed: %s', (err as Error).message)
    }
  }

  private startTokenRefresh(): void {
    if (this.tokenTimer) clearInterval(this.tokenTimer)
    // Refresh well inside the 15-minute expiry window.
    this.tokenTimer = setInterval(() => this.refreshToken(), 10 * 60 * 1000)
  }
}

export default new KrakenWebSocketService()
