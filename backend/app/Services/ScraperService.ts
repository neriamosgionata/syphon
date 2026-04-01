import Parser from 'rss-parser'
import * as cheerio from 'cheerio'
import Logger from '@ioc:Adonis/Core/Logger'
import ScrapeSource from 'App/Models/ScrapeSource'
import MeilisearchService from './MeilisearchService'
import { DateTime } from 'luxon'

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; Syphon/1.0; +https://github.com/syphon)',
  },
})

interface ScrapedArticle {
  externalId: string | null
  title: string
  summary: string | null
  content: string | null
  url: string
  author: string | null
  imageUrl: string | null
  publishedAt: DateTime | null
}

const DEFAULT_SOURCES = [
  {
    name: 'Google News - Business',
    slug: 'google-news-business',
    type: 'rss' as const,
    url: 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB',
  },
  {
    name: 'Google News - Finance',
    slug: 'google-news-finance',
    type: 'rss' as const,
    url: 'https://news.google.com/rss/search?q=stock+market+finance&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Yahoo Finance RSS',
    slug: 'yahoo-finance-rss',
    type: 'rss' as const,
    url: 'https://finance.yahoo.com/news/rssindex',
  },
  {
    name: 'MarketWatch',
    slug: 'marketwatch',
    type: 'rss' as const,
    url: 'http://feeds.marketwatch.com/marketwatch/topstories/',
  },
  {
    name: 'CNBC Finance',
    slug: 'cnbc-finance',
    type: 'rss' as const,
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
  },
  {
    name: 'Reuters Business',
    slug: 'reuters-business',
    type: 'rss' as const,
    url: 'https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best',
  },
  {
    name: 'Investing.com News',
    slug: 'investing-com',
    type: 'rss' as const,
    url: 'https://www.investing.com/rss/news.rss',
  },
  {
    name: 'Seeking Alpha',
    slug: 'seeking-alpha',
    type: 'rss' as const,
    url: 'https://seekingalpha.com/market_currents.xml',
  },
]

class ScraperService {
  public async ensureDefaultSources() {
    for (const source of DEFAULT_SOURCES) {
      const existing = await ScrapeSource.findBy('slug', source.slug)
      if (!existing) {
        await ScrapeSource.create(source)
        Logger.info('Created scrape source: %s', source.name)
      }
    }
  }

  public async scrapeSource(source: ScrapeSource): Promise<ScrapedArticle[]> {
    switch (source.type) {
      case 'rss':
        return this.scrapeRss(source)
      case 'html':
        return this.scrapeHtml(source)
      default:
        Logger.warn('Unknown source type: %s for %s', source.type, source.name)
        return []
    }
  }

  private async scrapeRss(source: ScrapeSource): Promise<ScrapedArticle[]> {
    const feed = await rssParser.parseURL(source.url)
    const articles: ScrapedArticle[] = []

    for (const item of feed.items) {
      if (!item.title || !item.link) continue

      const contentSnippet = item.contentSnippet || item.content || ''
      const cleanSummary = this.stripHtml(contentSnippet).slice(0, 1000)

      articles.push({
        externalId: item.guid || item.link,
        title: this.stripHtml(item.title).slice(0, 500),
        summary: cleanSummary || null,
        content: item.content ? this.stripHtml(item.content) : null,
        url: item.link,
        author: item.creator || item.author || null,
        imageUrl: this.extractImageUrl(item) || null,
        publishedAt: item.pubDate ? DateTime.fromJSDate(new Date(item.pubDate)) : null,
      })
    }

    return articles
  }

  private async scrapeHtml(source: ScrapeSource): Promise<ScrapedArticle[]> {
    const config = source.config || {}
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Syphon/1.0)',
      },
    })
    const html = await response.text()
    const $ = cheerio.load(html)
    const articles: ScrapedArticle[] = []

    const articleSelector = config.articleSelector || 'article'
    const titleSelector = config.titleSelector || 'h2 a, h3 a'
    const summarySelector = config.summarySelector || 'p'

    $(articleSelector).each((_i, el) => {
      const titleEl = $(el).find(titleSelector).first()
      const title = titleEl.text().trim()
      const url = titleEl.attr('href')
      const summary = $(el).find(summarySelector).first().text().trim()

      if (title && url) {
        articles.push({
          externalId: url,
          title: title.slice(0, 500),
          summary: summary.slice(0, 1000) || null,
          content: null,
          url: url.startsWith('http') ? url : new URL(url, source.url).href,
          author: null,
          imageUrl: null,
          publishedAt: null,
        })
      }
    })

    return articles
  }

  public async saveArticles(articles: ScrapedArticle[], source: ScrapeSource): Promise<number> {
    let saved = 0

    for (const data of articles) {
      // Dedup by externalId or URL
      let existing: any = null
      if (data.externalId) {
        existing = await MeilisearchService.findArticleByExternalId(data.externalId)
      }
      if (!existing) {
        existing = await MeilisearchService.findArticleByUrl(data.url)
      }

      if (!existing) {
        await MeilisearchService.saveArticle({
          ...data,
          publishedAt: data.publishedAt?.toISO() || null,
          sourceName: source.name,
          scrapeSourceId: source.id,
          isAnalyzed: false,
        })
        saved++
      }
    }

    source.lastScrapedAt = DateTime.now()
    source.errorCount = 0
    await source.save()

    return saved
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim()
  }

  private extractImageUrl(item: any): string | null {
    if (item.enclosure?.url) return item.enclosure.url
    if (item['media:content']?.['$']?.url) return item['media:content']['$'].url
    const match = (item.content || '').match(/<img[^>]+src="([^"]+)"/)
    return match ? match[1] : null
  }
}

export default new ScraperService()
