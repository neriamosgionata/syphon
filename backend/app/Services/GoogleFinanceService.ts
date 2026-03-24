import Logger from '@ioc:Adonis/Core/Logger'
import Ticker from 'App/Models/Ticker'
import TickerSnapshot from 'App/Models/TickerSnapshot'
import { DateTime } from 'luxon'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as cheerio from 'cheerio'

const execAsync = promisify(exec)

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const FINANCE_BASE = 'https://www.google.com/finance'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// Common symbol-to-exchange mappings for Google Finance URL format
const EXCHANGE_MAP: Record<string, string> = {
  NASDAQ: 'NASDAQ',
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NYSE: 'NYSE',
  NYQ: 'NYSE',
  NYSEARCA: 'NYSEARCA',
  PCX: 'NYSEARCA',
  NYSEAMERICAN: 'NYSEAMERICAN',
  BATS: 'NYSEARCA',
  LON: 'LON',
  LSE: 'LON',
  TYO: 'TYO',
  TSE: 'TYO',
  SHA: 'SHA',
  SHE: 'SHE',
  HKG: 'HKG',
  FRA: 'FRA',
  EPA: 'EPA',
  BIT: 'BIT',
  TSX: 'TSX',
  ASX: 'ASX',
}

class RateLimiter {
  private timestamps: number[] = []
  private queue: Array<{ resolve: () => void }> = []
  private processing = false

  constructor(
    private maxRequests: number = 5,
    private windowMs: number = 10_000
  ) {}

  private cleanup() {
    const cutoff = Date.now() - this.windowMs
    this.timestamps = this.timestamps.filter((t) => t > cutoff)
  }

  private async processQueue() {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      this.cleanup()
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(Date.now())
        this.queue.shift()!.resolve()
      } else {
        const oldest = this.timestamps[0]
        const waitMs = oldest + this.windowMs - Date.now() + 100
        await sleep(Math.max(waitMs, 500))
      }
    }

    this.processing = false
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ resolve })
      this.processQueue()
    })
  }

  async backoff(ms: number) {
    Logger.warn('[RateLimiter] Backing off for %dms', ms)
    const now = Date.now()
    this.timestamps = Array(this.maxRequests).fill(now + ms - this.windowMs)
    await sleep(ms)
  }
}

class GoogleFinanceService {
  private limiter = new RateLimiter(4, 10_000)
  private consecutiveErrors = 0
  // Cache resolved exchanges so we don't re-search every time
  private exchangeCache = new Map<string, string>()

  private async fetchHTML(url: string, retries = 3): Promise<string> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.limiter.acquire()

      try {
        const escapedUrl = url.replace(/'/g, "'\\''")
        const { stdout } = await execAsync(
          `curl -sL --max-time 15 -A '${UA}' -H 'Accept-Language: en-US,en;q=0.9' -w '\\n%{http_code}' '${escapedUrl}'`,
          { maxBuffer: 10 * 1024 * 1024 }
        )
        const lines = stdout.trimEnd().split('\n')
        const httpCode = parseInt(lines.pop()!, 10)
        const body = lines.join('\n')

        if (httpCode === 429) {
          this.consecutiveErrors++
          const backoffMs = Math.min(30_000 * this.consecutiveErrors, 120_000)
          Logger.warn(
            '[GoogleFinance] Rate limited (429) on %s — backing off %ds',
            url.substring(0, 60),
            backoffMs / 1000
          )
          await this.limiter.backoff(backoffMs)
          if (attempt < retries) continue
          throw new Error('Rate limited (429) after all retries')
        }

        this.consecutiveErrors = 0

        if (httpCode >= 400) {
          throw new Error(`HTTP ${httpCode}`)
        }
        return body
      } catch (error) {
        if (attempt < retries && !error.message.includes('after all retries')) {
          const delay = attempt * 3000
          Logger.warn(
            '[GoogleFinance] Fetch failed (%s): %s, retry %d/%d in %dms',
            url.substring(0, 60),
            error.message,
            attempt,
            retries,
            delay
          )
          await sleep(delay)
          continue
        }
        throw error
      }
    }
    throw new Error('fetchHTML exhausted retries')
  }

  private parsePrice(text: string): number | null {
    if (!text) return null
    const cleaned = text.replace(/[^0-9.\-]/g, '')
    const num = parseFloat(cleaned)
    return isNaN(num) ? null : num
  }

  private parseMarketCap(text: string): number | null {
    if (!text) return null
    const cleaned = text.trim().toUpperCase()
    const num = parseFloat(cleaned.replace(/[^0-9.]/g, ''))
    if (isNaN(num)) return null
    if (/T(?:\s|$|[^A-Z])/.test(cleaned) || cleaned.includes('TRILLION')) return num * 1e12
    if (/B(?:\s|$|[^A-Z])/.test(cleaned) || cleaned.includes('BILLION')) return num * 1e9
    if (/M(?:\s|$|[^A-Z])/.test(cleaned) || cleaned.includes('MILLION')) return num * 1e6
    if (/K(?:\s|$|[^A-Z])/.test(cleaned) || cleaned.includes('THOUSAND')) return num * 1e3
    return num
  }

  private static readonly COMMON_EXCHANGES = ['NASDAQ', 'NYSE', 'NYSEARCA', 'NYSEAMERICAN']

  public async fetchQuote(symbol: string, knownExchange?: string) {
    try {
      const upper = symbol.toUpperCase()

      const exchangesToTry: string[] = []
      if (knownExchange) exchangesToTry.push(knownExchange)
      const cached = this.exchangeCache.get(upper)
      if (cached && cached !== knownExchange) exchangesToTry.push(cached)
      for (const ex of GoogleFinanceService.COMMON_EXCHANGES) {
        if (!exchangesToTry.includes(ex)) exchangesToTry.push(ex)
      }

      for (const exchange of exchangesToTry) {
        const url = `${FINANCE_BASE}/quote/${encodeURIComponent(upper)}:${encodeURIComponent(exchange)}`
        let html: string
        try {
          html = await this.fetchHTML(url, 1)
        } catch {
          continue
        }

        if (!html.includes('data-last-price')) {
          continue
        }

        this.exchangeCache.set(upper, exchange)
        return this.parseQuotePage(html, upper, exchange)
      }

      Logger.warn('[GoogleFinance] Could not find quote for %s on any exchange', symbol)
      return null
    } catch (error) {
      Logger.error('[GoogleFinance] Failed to fetch quote for %s: %s', symbol, error.message)
      return null
    }
  }

  private parseQuotePage(html: string, symbol: string, exchange: string) {
    const $ = cheerio.load(html)

    let price: number | null = null
    const priceAttr = $('[data-last-price]').first().attr('data-last-price')
    if (priceAttr) {
      price = parseFloat(priceAttr)
    }

    let shortName: string | null = null
    const pageTitle = $('title').text()
    const titleMatch = pageTitle.match(/^(.+?)\s*(?:Stock Price|Share Price|ETF|\()/)
    if (titleMatch) {
      shortName = titleMatch[1].trim()
    }

    if (!shortName || shortName === symbol) {
      const heading = $('div[data-tab-id="summary"] h1, .zzDege').first().text()
      if (heading) shortName = heading.trim()
    }

    let yearRangeHigh: number | null = null
    let yearRangeLow: number | null = null
    let marketCap: number | null = null
    let peRatio: number | null = null
    let dividendYield: number | null = null
    let avgVolume: number | null = null

    $('div.gyFHrc, div.P6K39c').each((_i, el) => {
      const label = $(el).find('.mfs7Fc, .J9Jhg').text().trim().toLowerCase()
      const value = $(el).find('.P6K39c, .YMlKec').text().trim()

      if (label.includes('year range') || label.includes('52')) {
        const parts = value.split('-').map((p) => p.trim())
        if (parts.length === 2) {
          yearRangeLow = this.parsePrice(parts[0])
          yearRangeHigh = this.parsePrice(parts[1])
        }
      } else if (label.includes('market cap')) {
        marketCap = this.parseMarketCap(value)
      } else if (label.includes('p/e ratio') || label.includes('pe ratio')) {
        peRatio = this.parsePrice(value)
      } else if (label.includes('dividend yield')) {
        const pctMatch = value.match(/([\d.]+)%/)
        if (pctMatch) dividendYield = parseFloat(pctMatch[1]) / 100
      } else if (label.includes('avg volume') || label.includes('average volume')) {
        avgVolume = this.parseMarketCap(value)
      }
    })

    $('[data-attrid]').each((_i, el) => {
      const attrid = $(el).attr('data-attrid') || ''
      const value = $(el).text().trim()

      if (attrid.includes('52_week') && value.includes('-')) {
        const parts = value.split('-').map((p) => p.trim())
        if (parts.length >= 2) {
          yearRangeLow = yearRangeLow || this.parsePrice(parts[0])
          yearRangeHigh = yearRangeHigh || this.parsePrice(parts[parts.length - 1])
        }
      }
    })

    if (price === null) {
      Logger.warn('[GoogleFinance] Could not extract price for %s from page', symbol)
      return null
    }

    return {
      symbol,
      shortName: shortName || symbol,
      longName: null,
      exchange,
      regularMarketPrice: price,
      marketCap,
      fiftyTwoWeekHigh: yearRangeHigh,
      fiftyTwoWeekLow: yearRangeLow,
      averageDailyVolume3Month: avgVolume,
      trailingPE: peRatio,
      epsTrailingTwelveMonths: peRatio && price ? price / peRatio : null,
      dividendYield,
    }
  }

  /**
   * Fetch historical OHLCV data.
   *
   * Strategy priority:
   * 1. Stooq CSV download — reliable, 1Y+ of daily OHLCV, free
   * 2. Google Finance ds:11 embedded data — ~20 trading days with close+volume
   * 3. Google Finance AF_initDataCallback — legacy fallback
   */
  public async fetchHistorical(symbol: string, period1: string, _period2?: string, knownExchange?: string) {
    const bars = await this.fetchHistoricalFromStooq(symbol, period1)
    if (bars.length > 0) return bars

    // Fallback: scrape Google Finance embedded chart data (ds:11)
    return this.fetchHistoricalFromGooglePage(symbol, period1, knownExchange)
  }

  /**
   * Download historical data from Stooq CSV endpoint.
   * Stooq provides free OHLCV data sourced from exchanges.
   * Symbol mapping: US stocks/ETFs → symbol.us, dots → dashes (BRK.B → brk-b.us)
   */
  private async fetchHistoricalFromStooq(
    symbol: string,
    period1: string
  ): Promise<Array<{ date: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    try {
      const stooqSymbol = this.toStooqSymbol(symbol)
      const d1 = period1.replace(/-/g, '')
      const d2 = DateTime.now().toISODate()!.replace(/-/g, '')
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${d1}&d2=${d2}&i=d`

      await this.limiter.acquire()
      const { stdout } = await execAsync(
        `curl -sL --max-time 20 -A '${UA}' '${url}'`,
        { maxBuffer: 5 * 1024 * 1024 }
      )

      const lines = stdout.trim().split('\n')
      if (lines.length < 2 || !lines[0].startsWith('Date')) {
        Logger.debug('[Stooq] No data for %s (symbol: %s)', symbol, stooqSymbol)
        return []
      }

      const bars: Array<{ date: Date; open: number; high: number; low: number; close: number; volume: number }> = []
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',')
        if (cols.length < 5) continue
        const [dateStr, openStr, highStr, lowStr, closeStr, volStr] = cols
        const open = parseFloat(openStr)
        const high = parseFloat(highStr)
        const low = parseFloat(lowStr)
        const close = parseFloat(closeStr)
        if (isNaN(open) || isNaN(close)) continue

        bars.push({
          date: new Date(dateStr),
          open,
          high,
          low,
          close,
          volume: volStr ? Math.round(parseFloat(volStr)) : 0,
        })
      }

      bars.sort((a, b) => a.date.getTime() - b.date.getTime())
      if (bars.length > 0) {
        Logger.info('[Stooq] Downloaded %d bars for %s', bars.length, symbol)
      }
      return bars
    } catch (error) {
      Logger.warn('[Stooq] Failed for %s: %s', symbol, error.message)
      return []
    }
  }

  /**
   * Convert ticker symbol to Stooq format.
   * US stocks/ETFs: lowercase + .us suffix, dots → dashes
   */
  private toStooqSymbol(symbol: string): string {
    return symbol.toLowerCase().replace(/\./g, '-') + '.us'
  }

  /**
   * Extract daily chart data from Google Finance page (ds:11 key).
   * Returns ~20 trading days of close+volume data.
   */
  private async fetchHistoricalFromGooglePage(
    symbol: string,
    period1: string,
    knownExchange?: string
  ): Promise<Array<{ date: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    try {
      const exchange = knownExchange || this.exchangeCache.get(symbol.toUpperCase()) || null
      const quotePath = exchange
        ? `${encodeURIComponent(symbol)}:${encodeURIComponent(exchange)}`
        : encodeURIComponent(symbol)
      const url = `${FINANCE_BASE}/quote/${quotePath}`
      const html = await this.fetchHTML(url)

      const bars: Array<{ date: Date; open: number; high: number; low: number; close: number; volume: number }> = []
      const startDate = new Date(period1)

      // Strategy 1: ds:11 daily chart data — format: [[year,month,day,hour,...],[close,change,...],volume]
      const ds11Match = html.match(
        /AF_initDataCallback\(\{[^}]*key:\s*'ds:11'[^}]*data:([\s\S]*?)\}\s*\);/
      )
      if (ds11Match) {
        const entryPattern = /\[\[(\d{4}),(\d{1,2}),(\d{1,2}),\d+,null,null,null,\[-?\d+\]\],\[([\d.]+),[^\]]+\],?(\d+)?\]/g
        let m: RegExpExecArray | null
        while ((m = entryPattern.exec(ds11Match[1])) !== null) {
          const date = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
          if (date >= startDate) {
            const close = parseFloat(m[4])
            bars.push({ date, open: close, high: close, low: close, close, volume: m[5] ? parseInt(m[5]) : 0 })
          }
        }
      }

      // Strategy 2: AF_initDataCallback timestamp-based arrays (legacy)
      if (bars.length === 0) {
        const cbPattern = /AF_initDataCallback\(\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\s*\)/g
        let cbMatch: RegExpExecArray | null
        while ((cbMatch = cbPattern.exec(html)) !== null) {
          const pricePattern = /\[(\d{10,13}),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*(\d+))?\]/g
          let pm: RegExpExecArray | null
          while ((pm = pricePattern.exec(cbMatch[1])) !== null) {
            const ts = parseInt(pm[1])
            const date = new Date(ts > 1e12 ? ts : ts * 1000)
            if (date >= startDate) {
              bars.push({
                date,
                open: parseFloat(pm[2]),
                high: parseFloat(pm[3]),
                low: parseFloat(pm[4]),
                close: parseFloat(pm[5]),
                volume: pm[6] ? parseInt(pm[6]) : 0,
              })
            }
          }
        }
      }

      bars.sort((a, b) => a.date.getTime() - b.date.getTime())

      if (bars.length === 0) {
        Logger.debug('[GoogleFinance] No embedded chart data for %s', symbol)
      } else {
        Logger.info('[GoogleFinance] Extracted %d bars for %s from page', bars.length, symbol)
      }

      return bars
    } catch (error) {
      Logger.error('[GoogleFinance] Failed to fetch historical for %s: %s', symbol, error.message)
      return []
    }
  }

  public async searchTicker(query: string) {
    try {
      const url = `${FINANCE_BASE}?q=${encodeURIComponent(query)}`
      const html = await this.fetchHTML(url)
      const $ = cheerio.load(html)

      const results: Array<{ symbol: string; name: string; exchange: string }> = []

      $('a[href*="/finance/quote/"]').each((_i, el) => {
        const href = $(el).attr('href') || ''
        const quoteMatch = href.match(/\/finance\/quote\/([^:]+):([^?&#/]+)/)
        if (!quoteMatch) return

        const sym = decodeURIComponent(quoteMatch[1])
        const exch = decodeURIComponent(quoteMatch[2])

        const textParts = $(el).text().trim().split('\n').map((s) => s.trim()).filter(Boolean)
        const name = textParts.find((t) => t !== sym && t !== exch && t.length > 1) || sym

        if (!results.some((r) => r.symbol === sym && r.exchange === exch)) {
          results.push({ symbol: sym, name, exchange: exch })
        }
      })

      if (results.length === 0) {
        const callbackPattern = /AF_initDataCallback\(\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\s*\)/g
        let cbMatch: RegExpExecArray | null
        while ((cbMatch = callbackPattern.exec(html)) !== null) {
          const tickerPattern = /"([A-Z]{1,5})"\s*,\s*"([^"]{2,80})"\s*,\s*"([A-Z]{2,15})"/g
          let tickerMatch: RegExpExecArray | null
          while ((tickerMatch = tickerPattern.exec(cbMatch[1])) !== null) {
            const sym = tickerMatch[1]
            const name = tickerMatch[2]
            const exch = tickerMatch[3]
            if (!results.some((r) => r.symbol === sym)) {
              results.push({ symbol: sym, name, exchange: exch })
            }
          }
        }
      }

      return results.slice(0, 10)
    } catch (error) {
      Logger.error('[GoogleFinance] Failed to search ticker: %s', error.message)
      return []
    }
  }

  public async syncTicker(symbol: string): Promise<Ticker> {
    const existing = await Ticker.findBy('symbol', symbol.toUpperCase())
    const quote = await this.fetchQuote(symbol, existing?.exchange || undefined)
    if (!quote) throw new Error(`Could not fetch data for ${symbol}`)

    return this.syncTickerFromQuote(quote)
  }

  private async syncTickerFromQuote(quote: any): Promise<Ticker> {
    const symbol = (quote.symbol || '').toUpperCase()
    let ticker = await Ticker.findBy('symbol', symbol)

    const data = {
      symbol,
      name: quote.shortName || quote.longName || symbol,
      exchange: quote.exchange || null,
      sector: quote.sector || null,
      industry: quote.industry || null,
      currentPrice: quote.regularMarketPrice || null,
      marketCap: quote.marketCap || null,
      metadata: {
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
        averageVolume: quote.averageDailyVolume3Month,
        pe: quote.trailingPE,
        eps: quote.epsTrailingTwelveMonths,
        dividendYield: quote.dividendYield,
      },
      lastFetchedAt: DateTime.now(),
    }

    if (ticker) {
      ticker.merge(data)
      await ticker.save()
    } else {
      ticker = await Ticker.create(data)
    }

    return ticker
  }

  public async syncTickersBulk(symbols: string[], syncHistory = false): Promise<number> {
    let synced = 0

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i]
      try {
        const existing = await Ticker.findBy('symbol', symbol.toUpperCase())
        const knownExchange = existing?.exchange || undefined
        const quote = await this.fetchQuote(symbol, knownExchange)
        if (!quote) {
          Logger.warn('[GoogleFinance:BulkSync] No data for %s, skipping', symbol)
          continue
        }
        const ticker = await this.syncTickerFromQuote(quote)
        synced++
        Logger.info(
          '[GoogleFinance:BulkSync] %s synced (%d/%d). Price: %s',
          symbol,
          synced,
          symbols.length,
          ticker.currentPrice
        )

        if (syncHistory) {
          const created = await this.syncHistoricalSnapshots(ticker, 90)
          Logger.info('[GoogleFinance:BulkSync] %s: %d snapshots created', symbol, created)
        }
      } catch (error) {
        Logger.error('[GoogleFinance:BulkSync] Failed to sync %s: %s', symbol, error.message)
      }
    }

    return synced
  }

  /**
   * Sync historical snapshots for a ticker.
   *
   * Two-pronged approach:
   * 1. Try to extract embedded chart data from Google Finance page (backfill)
   * 2. Always upsert today's snapshot from the current price (daily accumulation)
   *
   * Over time, daily syncs (cron every 30 min) build up a complete price history.
   */
  public async syncHistoricalSnapshots(ticker: Ticker, days: number = 365) {
    let created = 0

    // Attempt to extract embedded historical data from the quote page
    const period1 = DateTime.now().minus({ days }).toISODate()!
    const history = await this.fetchHistorical(ticker.symbol, period1, undefined, ticker.exchange || undefined)

    for (const bar of history) {
      const date = DateTime.fromJSDate(bar.date).toISODate()!
      const existing = await TickerSnapshot.query()
        .where('ticker_id', ticker.id)
        .where('date', date)
        .first()

      if (!existing) {
        await TickerSnapshot.create({
          tickerId: ticker.id,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          changePercent: bar.open ? ((bar.close - bar.open) / bar.open) * 100 : null,
          date,
        })
        created++
      }
    }

    // Always save/update today's snapshot from current price
    if (ticker.currentPrice) {
      const today = DateTime.now().toISODate()!
      const todaySnap = await TickerSnapshot.query()
        .where('ticker_id', ticker.id)
        .where('date', today)
        .first()

      if (todaySnap) {
        // Update: track intraday high/low, always update close
        todaySnap.close = ticker.currentPrice
        if (!todaySnap.high || ticker.currentPrice > todaySnap.high) {
          todaySnap.high = ticker.currentPrice
        }
        if (!todaySnap.low || ticker.currentPrice < todaySnap.low) {
          todaySnap.low = ticker.currentPrice
        }
        todaySnap.changePercent = todaySnap.open
          ? ((ticker.currentPrice - todaySnap.open) / todaySnap.open) * 100
          : null
        await todaySnap.save()
      } else {
        await TickerSnapshot.create({
          tickerId: ticker.id,
          open: ticker.currentPrice,
          high: ticker.currentPrice,
          low: ticker.currentPrice,
          close: ticker.currentPrice,
          volume: null,
          changePercent: 0,
          date: today,
        })
        created++
      }
    }

    return created
  }

  public async getTickerSummary(symbol: string) {
    const [quote, ticker] = await Promise.all([
      this.fetchQuote(symbol),
      Ticker.query()
        .where('symbol', symbol.toUpperCase())
        .preload('snapshots', (q) => {
          q.orderBy('date', 'desc').limit(30)
        })
        .first(),
    ])

    return {
      quote,
      ticker,
      snapshots: ticker?.snapshots || [],
    }
  }
}

export default new GoogleFinanceService()
