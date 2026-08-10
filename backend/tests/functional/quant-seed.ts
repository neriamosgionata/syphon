// Seeds a synthetic AAPL ticker + price history into SQLite and Meilisearch so
// the Quant API specs run hermetically (they previously depended on whatever
// data happened to exist in the dev environment).
//
// Data is deterministic: a sine-driven daily series with periodic dips, which
// keeps every indicator in its expected range (RSI 0-100, drawdown 0-1, ...)
// across runs.

const SEED_SYMBOL = 'AAPL'
const SEED_DAYS = 260

interface SeedHandle {
  tickerId: number
  createdTicker: boolean
  snapshotIds: string[]
  analysisIds: string[]
}

function unwrapRows(res: any): any[] {
  return Array.isArray(res?.[0]) ? res[0] : res
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function seedTicker(Database: any): Promise<{ id: number; created: boolean }> {
  const rows = unwrapRows(await Database.rawQuery('SELECT id FROM tickers WHERE symbol = ?', [SEED_SYMBOL]))
  if (rows.length > 0) return { id: Number(rows[0].id), created: false }

  const res = await Database.rawQuery(
    `INSERT INTO tickers (symbol, name, is_active, created_at, updated_at)
     VALUES (?, ?, 1, datetime('now'), datetime('now'))`,
    [SEED_SYMBOL, SEED_SYMBOL]
  )
  const id = Number(res?.lastInsertRowid ?? res?.insertId)
  return { id, created: true }
}

function buildSnapshots(tickerId: number): { docs: any[]; ids: string[] } {
  const docs: any[] = []
  const ids: string[] = []
  const dayMs = 86400000
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  let price = 150
  for (let i = SEED_DAYS; i >= 1; i--) {
    const date = new Date(today.getTime() - i * dayMs).toISOString().slice(0, 10)
    const drift = Math.sin(i / 6) * 1.4
    price = Math.max(40, price + drift + (i % 6 === 0 ? -2.2 : 0.75))
    const open = +(price - 0.3).toFixed(2)
    const high = +(price + 1.3).toFixed(2)
    const low = +(price - 1.5).toFixed(2)
    const close = +price.toFixed(2)
    const prevClose = +(price - drift - 0.75 + (i % 6 === 0 ? 2.2 : 0)).toFixed(2)
    docs.push({
      tickerId,
      tickerSymbol: SEED_SYMBOL,
      open,
      high,
      low,
      close,
      volume: 50000000 + (i % 7) * 1200000,
      changePercent: prevClose > 0 ? +(((close - prevClose) / prevClose) * 100).toFixed(4) : 0,
      date,
    })
    ids.push(`${tickerId}_${date}`)
  }
  return { docs, ids }
}

function buildAnalyses(tickerId: number): { docs: any[]; ids: string[] } {
  const sentiments = [
    { sentiment: 'bullish', score: 0.7 },
    { sentiment: 'bearish', score: -0.5 },
    { sentiment: 'neutral', score: 0.1 },
    { sentiment: 'very_bullish', score: 0.85 },
    { sentiment: 'bullish', score: 0.55 },
    { sentiment: 'bearish', score: -0.3 },
  ]
  const docs = sentiments.map((s, i) => ({
    articleId: 900000 + i,
    tickerId,
    tickerSymbol: SEED_SYMBOL,
    sentiment: s.sentiment,
    sentimentScore: s.score,
    relevanceScore: 0.6 + i * 0.05,
    confidence: 0.5 + (i % 3) * 0.15,
    keywords: { topics: ['earnings'] },
    reasoning: `Seeded analysis ${i + 1} for ${SEED_SYMBOL}`,
    tickerPriceAtAnalysis: 150 + i,
  }))
  return {
    docs,
    ids: docs.map((d) => `${d.articleId}_${tickerId}`),
  }
}

export async function seedQuantData(): Promise<SeedHandle> {
  const { default: Database } = await import('@ioc:Adonis/Lucid/Database')
  const { default: Meili } = await import('App/Services/MeilisearchService')

  const { id: tickerId, created: createdTicker } = await seedTicker(Database)

  const { docs: snapshotDocs, ids: snapshotIds } = buildSnapshots(tickerId)
  await Meili.saveSnapshots(snapshotDocs)

  const { docs: analysisDocs, ids: analysisIds } = buildAnalyses(tickerId)
  for (const doc of analysisDocs) {
    await Meili.saveAnalysis(doc)
  }

  // Meilisearch indexes asynchronously: wait until the docs are searchable
  // before handing control back to the specs.
  const visible = await waitFor(async () => {
    const snaps = await Meili.getSnapshotsForTicker(tickerId)
    const analyses = await Meili.getAnalysesForTicker(tickerId)
    return snaps.length >= SEED_DAYS && analyses.length >= analysisDocs.length
  })
  if (!visible) {
    throw new Error('[quant-seed] Meilisearch did not finish indexing seeded data in time')
  }

  return { tickerId, createdTicker, snapshotIds, analysisIds }
}

export async function cleanupQuantData(handle: SeedHandle): Promise<void> {
  const { default: Database } = await import('@ioc:Adonis/Lucid/Database')
  const { default: Meili } = await import('App/Services/MeilisearchService')

  // Deletes only the documents this run seeded (ids are deterministic).
  await Meili['deleteDocs']('snapshots', handle.snapshotIds)
  await Meili['deleteDocs']('analyses', handle.analysisIds)

  if (handle.createdTicker) {
    await Database.rawQuery('DELETE FROM tickers WHERE id = ?', [handle.tickerId])
  }
}
