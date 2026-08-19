import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc'

interface GDELTArticle {
  url: string
  title: string
  seendate: string
  domain: string
  language: string
  sourcecountry: string
  socialimage?: string
}

export interface HistoricalArticle {
  externalId: string
  title: string
  summary: string | null
  content: string | null
  url: string
  author: string | null
  imageUrl: string | null
  publishedAt: DateTime | null
  domain: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class GDELTService {
  private lastRequestTime = 0

  /**
   * Rate limit: GDELT requires at least 5 seconds between requests.
   */
  private async throttle() {
    const now = Date.now()
    const elapsed = now - this.lastRequestTime
    if (elapsed < 6000) {
      await sleep(6000 - elapsed)
    }
    this.lastRequestTime = Date.now()
  }

  /**
   * Search GDELT DOC API for articles matching a query within a date range.
   * Returns up to 250 articles per request (GDELT max).
   *
   * @param query - Search terms (e.g., "Apple AAPL stock")
   * @param startDate - Start of range (YYYY-MM-DD)
   * @param endDate - End of range (YYYY-MM-DD)
   */
  public async searchArticles(
    query: string,
    startDate: string,
    endDate: string,
  ): Promise<GDELTArticle[]> {
    try {
      await this.throttle()

      const start = startDate.replace(/-/g, '') + '000000'
      const end = endDate.replace(/-/g, '') + '235959'

      const params = new URLSearchParams({
        query: `${query} sourcelang:eng`,
        mode: 'artlist',
        maxrecords: '250',
        format: 'json',
        startdatetime: start,
        enddatetime: end,
        sort: 'datedesc',
      })

      const url = `${GDELT_DOC_API}?${params.toString()}`

      const { stdout } = await execAsync(
        `curl -sL --max-time 30 -A '${UA}' '${url}'`,
        { maxBuffer: 10 * 1024 * 1024 }
      )

      // GDELT returns plain text error on rate limit, not JSON
      if (!stdout.trim().startsWith('{') && !stdout.trim().startsWith('[')) {
        if (stdout.includes('limit requests')) {
          logger.warn('[GDELT] Rate limited, waiting 10s before retry')
          await sleep(10000)
          this.lastRequestTime = Date.now()
          // Retry once
          const { stdout: retryOut } = await execAsync(
            `curl -sL --max-time 30 -A '${UA}' '${url}'`,
            { maxBuffer: 10 * 1024 * 1024 }
          )
          if (!retryOut.trim().startsWith('{')) {
            logger.warn('[GDELT] Still rate limited after retry')
            return []
          }
          const retryData = JSON.parse(retryOut)
          return retryData?.articles || []
        }
        logger.warn('[GDELT] Unexpected response: %s', stdout.slice(0, 200))
        return []
      }

      const data = JSON.parse(stdout)
      return data?.articles || []
    } catch (error) {
      logger.warn('[GDELT] Search failed for "%s": %s', query, (error as Error).message)
      return []
    }
  }

  /**
   * Search for articles about a specific ticker/company across a date range.
   * Splits into monthly chunks to maximize coverage (GDELT returns max 250 per request).
   */
  public async searchByTicker(
    symbol: string,
    companyName: string,
    startDate: string,
    endDate: string,
    onProgress?: (month: string, found: number) => void,
  ): Promise<HistoricalArticle[]> {
    const start = DateTime.fromISO(startDate)
    const end = DateTime.fromISO(endDate)
    const allArticles: HistoricalArticle[] = []
    const seenUrls = new Set<string>()

    // Build search query: symbol + cleaned company name
    const cleanName = companyName
      .replace(/\s+(Inc|Corp|Corporation|Ltd|Limited|LLC|PLC|Co)\.?\s*$/i, '')
      .trim()
    const query = cleanName.length > 2
      ? `"${cleanName}" OR "${symbol}" stock`
      : `"${symbol}" stock market`

    // Iterate monthly
    let cursor = start
    while (cursor < end) {
      const monthEnd = cursor.plus({ months: 1 }) > end ? end : cursor.plus({ months: 1 })
      const monthStr = cursor.toFormat('yyyy-MM')

      const results = await this.searchArticles(
        query,
        cursor.toISODate()!,
        monthEnd.toISODate()!,
      )

      let added = 0
      for (const article of results) {
        if (seenUrls.has(article.url)) continue
        seenUrls.add(article.url)

        const parsed = this.parseGDELTArticle(article)
        if (parsed) {
          allArticles.push(parsed)
          added++
        }
      }

      if (onProgress) {
        onProgress(monthStr, added)
      }

      logger.debug('[GDELT] %s %s: %d articles found, %d new', symbol, monthStr, results.length, added)
      cursor = monthEnd
    }

    return allArticles
  }

  /**
   * Fetch and extract readable text content from an article URL.
   */
  public async fetchContent(url: string): Promise<{ summary: string | null; content: string | null }> {
    try {
      await this.throttle()

      const escapedUrl = url.replace(/'/g, "'\\''")
      const { stdout } = await execAsync(
        `curl -sL --max-time 15 -A '${UA}' -H 'Accept-Language: en-US,en;q=0.9' '${escapedUrl}'`,
        { maxBuffer: 5 * 1024 * 1024 }
      )

      if (!stdout || stdout.length < 100) return { summary: null, content: null }

      // Extract text from common article containers
      const { load } = await import('cheerio')
      const $ = load(stdout)

      // Remove noise
      $('script, style, nav, header, footer, aside, .ad, .advertisement, .social, .comments, .sidebar').remove()

      // Try common article selectors
      let content = ''
      const selectors = ['article', '[role="article"]', '.article-body', '.post-content', '.entry-content', '.story-body', 'main']
      for (const sel of selectors) {
        const el = $(sel)
        if (el.length && el.text().trim().length > 200) {
          content = el.text().trim()
          break
        }
      }

      if (!content) {
        // Fallback: collect all paragraph text
        const paragraphs: string[] = []
        $('p').each((_i, el) => {
          const text = $(el).text().trim()
          if (text.length > 40) paragraphs.push(text)
        })
        content = paragraphs.join('\n\n')
      }

      if (!content || content.length < 50) return { summary: null, content: null }

      // Clean up whitespace
      content = content.replace(/\s+/g, ' ').trim()

      const summary = content.slice(0, 1000)
      return {
        summary: summary.length < content.length ? summary : null,
        content: content.slice(0, 10000),
      }
    } catch {
      return { summary: null, content: null }
    }
  }

  private parseGDELTArticle(article: GDELTArticle): HistoricalArticle | null {
    if (!article.url || !article.title) return null

    let publishedAt: DateTime | null = null
    if (article.seendate) {
      // GDELT format: "20230415T120000Z"
      const match = article.seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
      if (match) {
        publishedAt = DateTime.fromObject({
          year: parseInt(match[1]),
          month: parseInt(match[2]),
          day: parseInt(match[3]),
          hour: parseInt(match[4]),
          minute: parseInt(match[5]),
          second: parseInt(match[6]),
        }, { zone: 'utc' })
      }
    }

    return {
      externalId: `gdelt:${article.url}`,
      title: article.title.slice(0, 500),
      summary: null,
      content: null,
      url: article.url,
      author: null,
      imageUrl: article.socialimage || null,
      publishedAt,
      domain: article.domain || '',
    }
  }
}

export default new GDELTService()
