import Logger from '@ioc:Adonis/Core/Logger'
import Ticker from 'App/Models/Ticker'
import TickerSnapshot from 'App/Models/TickerSnapshot'
import { DateTime } from 'luxon'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const SEARCH_BASE = 'https://query1.finance.yahoo.com/v1/finance/search'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

class YahooFinanceService {
  private async fetchJSON(url: string, retries = 3): Promise<any> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Use shell curl which handles DNS round-robin and connection reuse properly
        const escapedUrl = url.replace(/'/g, "'\\''")
        const { stdout } = await execAsync(
          `curl -s --max-time 15 -A '${UA}' -w '\\n%{http_code}' '${escapedUrl}'`,
          { maxBuffer: 10 * 1024 * 1024 }
        )
        const lines = stdout.trimEnd().split('\n')
        const httpCode = parseInt(lines.pop()!, 10)
        const body = lines.join('\n')
        if (httpCode === 429) {
          throw new Error('Rate limited (429)')
        }
        if (httpCode >= 400) {
          throw new Error(`HTTP ${httpCode}: ${body.substring(0, 100)}`)
        }
        return JSON.parse(body)
      } catch (error) {
        if (attempt < retries) {
          const delay = attempt * 5000
          Logger.warn('Fetch failed (%s): %s, retry %d/%d in %dms', url.substring(0, 60), error.message, attempt, retries, delay)
          await sleep(delay)
          continue
        }
        throw error
      }
    }
  }

  public async fetchQuote(symbol: string) {
    try {
      const data = await this.fetchJSON(`${CHART_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`)
      const meta = data?.chart?.result?.[0]?.meta
      if (!meta) return null
      return {
        symbol: meta.symbol,
        shortName: meta.shortName || meta.symbol,
        longName: meta.longName || null,
        exchange: meta.exchangeName || null,
        regularMarketPrice: meta.regularMarketPrice,
        marketCap: null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        averageDailyVolume3Month: null,
        trailingPE: null,
        epsTrailingTwelveMonths: null,
        dividendYield: null,
      }
    } catch (error) {
      Logger.error('Failed to fetch quote for %s: %s', symbol, error.message)
      return null
    }
  }

  public async fetchHistorical(symbol: string, period1: string, period2?: string) {
    try {
      const p1 = Math.floor(new Date(period1).getTime() / 1000)
      const p2 = period2 ? Math.floor(new Date(period2).getTime() / 1000) : Math.floor(Date.now() / 1000)
      const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`
      const data = await this.fetchJSON(url)
      const result = data?.chart?.result?.[0]
      if (!result) return []

      const timestamps = result.timestamp || []
      const ohlcv = result.indicators?.quote?.[0] || {}
      const bars: any[] = []

      for (let i = 0; i < timestamps.length; i++) {
        if (ohlcv.open?.[i] != null) {
          bars.push({
            date: new Date(timestamps[i] * 1000),
            open: ohlcv.open[i],
            high: ohlcv.high[i],
            low: ohlcv.low[i],
            close: ohlcv.close[i],
            volume: ohlcv.volume[i],
          })
        }
      }
      return bars
    } catch (error) {
      Logger.error('Failed to fetch historical data for %s: %s', symbol, error.message)
      return []
    }
  }

  public async searchTicker(query: string) {
    try {
      const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`
      const data = await this.fetchJSON(url)
      return (data.quotes || [])
        .filter((q: any) => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
        .map((q: any) => ({
          symbol: q.symbol,
          name: q.shortname || q.longname || q.symbol,
          exchange: q.exchange,
        }))
    } catch (error) {
      Logger.error('Failed to search ticker: %s', error.message)
      return []
    }
  }

  public async syncTicker(symbol: string): Promise<Ticker> {
    const quote = await this.fetchQuote(symbol)
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
        const quote = await this.fetchQuote(symbol)
        if (!quote) {
          Logger.warn('[BulkSync] No data for %s, skipping', symbol)
          continue
        }
        const ticker = await this.syncTickerFromQuote(quote)
        synced++
        Logger.info('[BulkSync] %s synced (%d/%d). Price: %s', symbol, synced, symbols.length, ticker.currentPrice)

        if (syncHistory) {
          await sleep(1000)
          const created = await this.syncHistoricalSnapshots(ticker, 90)
          Logger.info('[BulkSync] %s: %d snapshots created', symbol, created)
        }

        if (i < symbols.length - 1) await sleep(300)
      } catch (error) {
        Logger.error('[BulkSync] Failed to sync %s: %s', symbol, error.message)
      }
    }

    return synced
  }

  public async syncHistoricalSnapshots(ticker: Ticker, days: number = 90) {
    const period1 = DateTime.now().minus({ days }).toISODate()!
    const history = await this.fetchHistorical(ticker.symbol, period1)

    let created = 0
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

    return created
  }

  public async getTickerSummary(symbol: string) {
    const [quote, ticker] = await Promise.all([
      this.fetchQuote(symbol),
      Ticker.query().where('symbol', symbol.toUpperCase()).preload('snapshots', (q) => {
        q.orderBy('date', 'desc').limit(30)
      }).first(),
    ])

    return {
      quote,
      ticker,
      snapshots: ticker?.snapshots || [],
    }
  }
}

export default new YahooFinanceService()
