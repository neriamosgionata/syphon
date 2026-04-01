import { BigQuery } from '@google-cloud/bigquery'
import Logger from '@ioc:Adonis/Core/Logger'
import Env from '@ioc:Adonis/Core/Env'
import { DateTime } from 'luxon'

export interface GDELTArticleResult {
  url: string
  title: string
  publishedAt: DateTime | null
  domain: string
  tone: number | null
  themes: string[]
  organizations: string[]
  imageUrl: string | null
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

class GDELTBigQueryService {
  private client: BigQuery | null = null

  private getClient(): BigQuery {
    if (!this.client) {
      const projectId = Env.get('GCP_PROJECT_ID', '')
      if (!projectId) {
        throw new Error('GCP_PROJECT_ID env var is required for BigQuery GDELT queries')
      }
      const keyFilename = Env.get('GOOGLE_APPLICATION_CREDENTIALS', '')
      this.client = new BigQuery({
        projectId,
        ...(keyFilename ? { keyFilename } : {}),
      })
    }
    return this.client
  }

  /**
   * Search GDELT GKG (Global Knowledge Graph) on BigQuery for articles
   * mentioning a company/ticker within a date range.
   *
   * Uses the partitioned table to minimize query cost.
   */
  public async searchByTicker(
    symbol: string,
    companyName: string,
    startDate: string,
    endDate: string,
    onProgress?: (msg: string, count: number) => void,
  ): Promise<HistoricalArticle[]> {
    const bq = this.getClient()

    const cleanName = companyName
      .replace(/\s+(Inc|Corp|Corporation|Ltd|Limited|LLC|PLC|Co)\.?\s*$/i, '')
      .trim()

    // Build search terms for the GDELT GKG V1Themes and Organizations columns
    const searchTerms = [symbol.toUpperCase()]
    if (cleanName.length > 2) searchTerms.push(cleanName)

    // GDELT GKG stores organizations in uppercase
    const orgConditions = searchTerms.map((t) => `UPPER(Organizations) LIKE '%${t.toUpperCase()}%'`).join(' OR ')
    const themeConditions = searchTerms.map((t) => `UPPER(V2Themes) LIKE '%${t.toUpperCase()}%'`).join(' OR ')

    const query = `
      SELECT
        DocumentIdentifier AS url,
        COALESCE(
          REGEXP_EXTRACT(Extras, r'<PAGE_TITLE>(.*?)</PAGE_TITLE>'),
          SPLIT(DocumentIdentifier, '/')[SAFE_OFFSET(ARRAY_LENGTH(SPLIT(DocumentIdentifier, '/')) - 1)]
        ) AS title,
        DATE AS gkg_date,
        SourceCommonName AS domain,
        V2Tone AS tone_str,
        V2Themes AS themes,
        Organizations AS organizations,
        SocialImageEmbeds AS image_url
      FROM \`gdelt-bq.gdeltv2.gkg_partitioned\`
      WHERE
        _PARTITIONTIME >= TIMESTAMP('${startDate}')
        AND _PARTITIONTIME <= TIMESTAMP('${endDate}')
        AND (${orgConditions} OR ${themeConditions})
        AND REGEXP_CONTAINS(DocumentIdentifier, r'^https?://')
        AND SourceCommonName IS NOT NULL
        AND TranslationInfo IS NULL
      ORDER BY DATE DESC
      LIMIT 5000
    `

    Logger.info('[GDELT-BQ] Querying for %s (%s), %s to %s', symbol, cleanName, startDate, endDate)

    if (onProgress) onProgress('Running BigQuery...', 0)

    const [rows] = await bq.query({ query, location: 'US' })

    Logger.info('[GDELT-BQ] Got %d raw results for %s', rows.length, symbol)
    if (onProgress) onProgress(`Processing ${rows.length} results`, rows.length)

    const articles: HistoricalArticle[] = []
    const seenUrls = new Set<string>()

    for (const row of rows) {
      const url = row.url
      if (!url || seenUrls.has(url)) continue
      seenUrls.add(url)

      let publishedAt: DateTime | null = null
      if (row.gkg_date) {
        const dateStr = String(row.gkg_date)
        // GKG date format: YYYYMMDDHHMMSS
        const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
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

      // Extract title - clean up the extracted value
      let title = row.title || ''
      if (!title || title.length < 5) {
        // Use last URL segment as fallback
        try {
          const urlPath = new URL(url).pathname
          title = urlPath.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || url
        } catch {
          title = url
        }
      }

      // Parse tone (V2Tone is comma-separated: tone,positive,negative,polarity,...)
      let tone: number | null = null
      if (row.tone_str) {
        const parts = String(row.tone_str).split(',')
        tone = parseFloat(parts[0]) || null
      }

      articles.push({
        externalId: `gdelt-bq:${url}`,
        title: title.slice(0, 500),
        summary: tone !== null ? `GDELT tone: ${tone.toFixed(2)}` : null,
        content: null,
        url,
        author: null,
        imageUrl: row.image_url || null,
        publishedAt,
        domain: row.domain || '',
      })
    }

    Logger.info('[GDELT-BQ] %s: %d unique articles after dedup', symbol, articles.length)
    if (onProgress) onProgress('Done', articles.length)

    return articles
  }

  /**
   * Quick check that BigQuery credentials and access work.
   */
  public async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const bq = this.getClient()
      await bq.query({
        query: 'SELECT COUNT(*) as cnt FROM `gdelt-bq.gdeltv2.gkg_partitioned` WHERE _PARTITIONTIME >= TIMESTAMP("2025-03-01") LIMIT 1',
        location: 'US',
      })
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }
}

export default new GDELTBigQueryService()
