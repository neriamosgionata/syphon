import { Job } from 'bullmq'
import Logger from '@ioc:Adonis/Core/Logger'
import { DateTime } from 'luxon'
import Ticker from 'App/Models/Ticker'
import ScrapeSource from 'App/Models/ScrapeSource'
import MeilisearchService from 'App/Services/MeilisearchService'
import GDELTBigQueryService from 'App/Services/GDELTBigQueryService'
import QueueService, { QUEUE_NAMES } from './QueueService'

const GDELT_SOURCE_SLUG = 'gdelt-bigquery'

async function ensureGDELTSource(): Promise<ScrapeSource> {
  let source = await ScrapeSource.findBy('slug', GDELT_SOURCE_SLUG)
  if (!source) {
    // Also check for old slug from REST API version
    source = await ScrapeSource.findBy('slug', 'gdelt-historical')
    if (source) {
      source.slug = GDELT_SOURCE_SLUG
      source.name = 'GDELT BigQuery'
      await source.save()
    } else {
      source = await ScrapeSource.create({
        name: 'GDELT BigQuery',
        slug: GDELT_SOURCE_SLUG,
        type: 'api' as any,
        url: 'https://bigquery.googleapis.com',
        isActive: true,
      })
    }
  }
  return source
}

export async function processBackfillNews(job: Job) {
  const { symbol, days } = job.data
  const daysBack = days || 1825

  const ticker = await Ticker.findBy('symbol', (symbol || '').toUpperCase())
  if (!ticker) throw new Error(`Ticker ${symbol} not found`)

  const source = await ensureGDELTSource()

  const endDate = DateTime.now().toISODate()!
  const startDate = DateTime.now().minus({ days: daysBack }).toISODate()!

  await job.updateProgress({ percent: 5, stage: 'Querying BigQuery', detail: `${ticker.symbol}: ${startDate} to ${endDate}` })

  Logger.info('[BackfillNews] Starting for %s (%s), %d days back via BigQuery', ticker.symbol, ticker.name, daysBack)

  const articles = await GDELTBigQueryService.searchByTicker(
    ticker.symbol,
    ticker.name,
    startDate,
    endDate,
    (msg, count) => {
      job.updateProgress({ percent: 10, stage: msg, detail: `${ticker.symbol}: ${count} articles` })
    },
  )

  await job.updateProgress({ percent: 50, stage: 'Saving articles', detail: `Found ${articles.length} total` })

  let saved = 0
  let skipped = 0

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i]

    // Dedup by externalId or URL
    let existing = await MeilisearchService.findArticleByExternalId(article.externalId)
    if (!existing) {
      existing = await MeilisearchService.findArticleByUrl(article.url)
    }

    if (existing) {
      skipped++
      continue
    }

    await MeilisearchService.saveArticle({
      externalId: article.externalId,
      title: article.title,
      summary: article.summary,
      content: article.content,
      url: article.url,
      author: article.author,
      imageUrl: article.imageUrl,
      publishedAt: article.publishedAt?.toISO() || null,
      sourceName: source.name,
      scrapeSourceId: source.id,
      isAnalyzed: false,
    })
    saved++

    if (saved % 100 === 0) {
      const pct = 50 + Math.round((i / articles.length) * 40)
      await job.updateProgress({ percent: pct, stage: 'Saving', detail: `${saved} saved, ${skipped} dupes` })
    }
  }

  // Queue saved articles for analysis
  const unanalyzed = await MeilisearchService.getUnanalyzedArticles(500)

  if (unanalyzed.length > 0) {
    await QueueService.addBulk(
      QUEUE_NAMES.ANALYZE_ARTICLE,
      unanalyzed.map((a) => ({ data: { articleId: a.id } }))
    )
  }

  await job.updateProgress({ percent: 100, stage: 'Complete', detail: `${saved} new, ${skipped} dupes, ${unanalyzed.length} queued for analysis` })

  Logger.info(
    '[BackfillNews] %s: %d new articles saved, %d duplicates, %d queued for analysis',
    ticker.symbol, saved, skipped, unanalyzed.length
  )

  return { symbol: ticker.symbol, found: articles.length, saved, skipped, queued: unanalyzed.length }
}

export function registerBackfillNewsWorker() {
  return QueueService.registerWorker(QUEUE_NAMES.BACKFILL_NEWS, processBackfillNews, 1)
}
