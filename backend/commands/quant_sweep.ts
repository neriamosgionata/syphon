import { BaseCommand } from '@adonisjs/core/ace'
import Ticker from '#models/Ticker'
import MeilisearchService from '#services/MeilisearchService'
import {
  validateTicker, summarizeValidation, spearman, ValidationRow,
} from '#services/QuantValidator'
import {
  QUANT_DEFAULT_WEIGHTS, scoreFromBreakdown, QuantWeights,
} from '#services/QuantEngine'

// Evidence-driven composite-weight search. Runs the point-in-time
// validation ONCE (rows keep per-component scores + presence masks), then
// re-scores the cached rows under every candidate weight set — the
// composite is a weighted average, so no re-computation of indicators is
// needed. One-at-a-time multipliers around the defaults + zeroing the
// negative-IC components (quant:validate showed trend/momentum/sharpe
// rank INVERTED at 20d). Ranked by train cross-sectional IC; the test
// (later dates) IC is reported for every candidate so winners can't be
// pure in-sample luck.

const COMPONENTS = Object.keys(QUANT_DEFAULT_WEIGHTS) as Array<keyof QuantWeights>
const MULTIPLIERS = [0, 0.5, 1.5, 2]

function crossSectionalIc(
  rowsByTicker: Map<string, ValidationRow[]>,
  opts: { maxDate?: string; minDate?: string } = {}
): number | null {
  const byDate = new Map<string, { composites: number[]; forwards: number[] }>()
  for (const rows of rowsByTicker.values()) {
    for (const r of rows) {
      if (opts.maxDate && r.date > opts.maxDate) continue
      if (opts.minDate && r.date <= opts.minDate) continue
      const entry = byDate.get(r.date)
      if (entry) {
        entry.composites.push(r.composite)
        entry.forwards.push(r.forwardRet ?? 0)
      } else {
        byDate.set(r.date, { composites: [r.composite], forwards: [r.forwardRet ?? 0] })
      }
    }
  }
  const ics: Array<number | null> = []
  for (const entry of byDate.values()) {
    if (entry.composites.length < 3) continue
    ics.push(spearman(entry.composites, entry.forwards))
  }
  const valid = ics.filter((v): v is number => v !== null)
  return valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : null
}

export default class QuantSweep extends BaseCommand {
  static commandName = 'quant:sweep'
  static description = 'Grid-search composite weights to maximize cross-sectional IC (train/test split)'
  static options = { startApp: true }

  static flags = [
    { flagName: 'symbols', name: 'symbols', type: 'string', description: 'Comma-separated symbols (default: all active tickers)' },
    { flagName: 'step', name: 'step', type: 'number', description: 'Validation cadence (default 5)' },
    { flagName: 'forward', name: 'forward', type: 'number', description: 'Forward horizon (default 20)' },
    { flagName: 'top', name: 'top', type: 'number', description: 'Configs to show (default 12)' },
    { flagName: 'maxTickers', name: 'maxTickers', type: 'number', description: 'Cap on tickers (default 0 = all)' },
  ]

  async run() {
    const symbolsRaw = String(this.parsed.flags.symbols || '').toUpperCase()
    const step = Number(this.parsed.flags.step ?? 5)
    const forward = Number(this.parsed.flags.forward ?? 20)
    const topN = Number(this.parsed.flags.top ?? 12)
    const maxTickers = Number(this.parsed.flags.maxTickers ?? 0)

    const tickers = symbolsRaw
      ? await Ticker.query().whereIn('symbol', symbolsRaw.split(',').map((s) => s.trim())).where('is_active', true)
      : await Ticker.query().where('is_active', true).orderBy('symbol')
    const wanted = maxTickers > 0 ? tickers.slice(0, maxTickers) : tickers

    const spy = await Ticker.findBy('symbol', 'SPY')
    const spySnapshots = spy ? await MeilisearchService.getSnapshotsForTicker(spy.id) : []
    const spyCloses = spySnapshots.map((s: any) => Number(s.close)).filter(Boolean)
    const spyReturns = spyCloses.map((c: number, i: number, arr: number[]) => (i === 0 ? 0 : c / arr[i - 1] - 1))

    this.logger.info(`═══ Quant weight sweep: ${wanted.length} tickers, forward ${forward}d ═══`)
    this.logger.info('Pass 1: point-in-time validation (cached rows)…')

    const rowsByTicker = new Map<string, ValidationRow[]>()
    for (const ticker of wanted) {
      const snapshots = await MeilisearchService.getSnapshotsForTicker(ticker.id)
      if (snapshots.length < 81) continue
      const analyses = await MeilisearchService.getAnalysesForTicker(
        ticker.id,
        new Date(Date.now() - 400 * 86400000).toISOString()
      )
      const bars = snapshots.map((s: any) => ({
        date: s.date,
        open: Number(s.open || s.close) || 0,
        high: Number(s.high || s.close) || 0,
        low: Number(s.low || s.close) || 0,
        close: Number(s.close) || 0,
        volume: Number(s.volume) || 0,
      }))
      const result = validateTicker({
        symbol: ticker.symbol, bars, analyses, spyReturns,
        meta: ticker.metadata, secType: ticker.secType,
        step, forward,
      })
      rowsByTicker.set(ticker.symbol, result.rows)
    }

    const allDates = [...new Set([...rowsByTicker.values()].flat().map((r) => r.date))].sort()
    const splitDate = allDates[Math.floor(allDates.length * 0.7)]
    this.logger.info(`Cached ${[...rowsByTicker.values()].flat().length} rows; train ≤ ${splitDate}, test > ${splitDate}`)

    // Baseline.
    const baselineIc = crossSectionalIc(rowsByTicker)
    // Candidate weight sets: one-at-a-time grid + zeroing negatives.
    const candidates: Array<{ label: string; weights: QuantWeights }> = [
      { label: 'baseline', weights: { ...QUANT_DEFAULT_WEIGHTS } },
    ]
    for (const key of COMPONENTS) {
      for (const mult of MULTIPLIERS) {
        const value = Math.round(QUANT_DEFAULT_WEIGHTS[key] * mult)
        if (value === QUANT_DEFAULT_WEIGHTS[key]) continue
        candidates.push({
          label: `${key}×${mult}`,
          weights: { ...QUANT_DEFAULT_WEIGHTS, [key]: value },
        })
      }
    }

    const results: Array<{ label: string; trainIc: number | null; testIc: number | null; score: number | null }> = []

    for (const candidate of candidates) {
      // Re-score cached rows under the candidate weights.
      for (const rows of rowsByTicker.values()) {
        for (const r of rows) {
          const { score } = scoreFromBreakdown(r.components as any, candidate.weights, r.present)
          r.composite = score
        }
      }
      const trainIc = crossSectionalIc(rowsByTicker, { maxDate: splitDate })
      const testIc = crossSectionalIc(rowsByTicker, { minDate: splitDate })
      results.push({ label: candidate.label, trainIc, testIc, score: trainIc })
    }

    const ranked = results.sort((a, b) => (b.trainIc ?? -1) - (a.trainIc ?? -1)).slice(0, topN)

    this.logger.info('')
    this.logger.info(`═══ Top ${ranked.length} by TRAIN cross-sectional IC ═══`)
    this.logger.info(`${'config'.padEnd(22)} train IC   test IC`)
    for (const r of ranked) {
      this.logger.info(`${r.label.padEnd(22)} ${(r.trainIc ?? 0).toFixed(3).padStart(7)}  ${(r.testIc ?? 0).toFixed(3).padStart(7)}`)
    }
    this.logger.info('')
    this.logger.info(`Baseline full-sample cross-IC: ${baselineIc?.toFixed(3) ?? 'n/a'}`)
    this.logger.info('NOTE: train wins can still be in-sample luck — the test IC column is the honesty check.')
  }
}