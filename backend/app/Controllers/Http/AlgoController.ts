import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import AlgoConfig from 'App/Models/AlgoConfig'
import AlgoPosition from 'App/Models/AlgoPosition'
import AlgoTradingService from 'App/Services/AlgoTradingService'
import MeilisearchService from 'App/Services/MeilisearchService'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'

export default class AlgoController {
  public async getConfig({ response }: HttpContextContract) {
    const config = await AlgoConfig.getConfig()
    return response.ok(config)
  }

  public async updateConfig({ request, response }: HttpContextContract) {
    const config = await AlgoConfig.getConfig()
    const body = request.body()

    const allowedFields = [
      'dryRun', 'broker', 'entryScoreThreshold', 'minConviction', 'minArticles',
      'allowedRegimes', 'maxPositions', 'maxExposurePct', 'maxSinglePositionPct',
      'dailyLossLimitPct', 'exitScoreThreshold', 'maxHoldingDays', 'orderType',
      'timeInForce', 'cooldownMinutes', 'excludedSymbols',
    ]

    const numericRanges: Record<string, [number, number]> = {
      entryScoreThreshold: [1, 100],
      minConviction: [0, 1],
      minArticles: [0, 50],
      maxPositions: [1, 50],
      maxExposurePct: [0.1, 1],
      maxSinglePositionPct: [0.01, 0.5],
      dailyLossLimitPct: [0.01, 0.2],
      exitScoreThreshold: [-100, 0],
      maxHoldingDays: [1, 365],
      cooldownMinutes: [1, 60],
    }

    const stringEnums: Record<string, string[]> = {
      broker: ['ibkr', 'kraken', 'binance'],
      orderType: ['MKT', 'LMT'],
      timeInForce: ['DAY', 'GTC'],
    }

    const validRegimes = ['trending_up', 'trending_down', 'ranging', 'volatile']

    for (const field of allowedFields) {
      // Convert camelCase from body to snake_case keys too
      const snakeField = field.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
      let value = body[field] ?? body[snakeField]
      if (value === undefined) continue

      if (field === 'dryRun') {
        value = value === true || value === 'true' || value === 1 || value === '1'
      } else if (numericRanges[field]) {
        const num = Number(value)
        if (!Number.isFinite(num)) {
          return response.badRequest({ error: `${field} must be a number` })
        }
        const [min, max] = numericRanges[field]
        if (num < min || num > max) {
          return response.badRequest({ error: `${field} must be between ${min} and ${max}` })
        }
        value = num
      } else if (stringEnums[field]) {
        if (!stringEnums[field].includes(value)) {
          return response.badRequest({ error: `${field} must be one of: ${stringEnums[field].join(', ')}` })
        }
      } else if (field === 'allowedRegimes' || field === 'excludedSymbols') {
        if (!Array.isArray(value)) {
          return response.badRequest({ error: `${field} must be an array` })
        }
        if (field === 'allowedRegimes') {
          const invalid = value.filter((r: string) => !validRegimes.includes(r))
          if (invalid.length > 0) {
            return response.badRequest({ error: `allowedRegimes contains invalid values: ${invalid.join(', ')}` })
          }
        }
      }

      ;(config as any)[field] = value
    }

    await config.save()
    return response.ok(config)
  }

  public async enable({ response }: HttpContextContract) {
    const config = await AlgoConfig.getConfig()
    config.enabled = true
    config.disabledReason = null
    await config.save()
    return response.ok({ enabled: true, message: 'Algorithm enabled' })
  }

  public async disable({ response }: HttpContextContract) {
    const config = await AlgoConfig.getConfig()
    config.enabled = false
    config.disabledReason = 'manually disabled'
    await config.save()
    return response.ok({ enabled: false, message: 'Algorithm disabled' })
  }

  public async triggerRun({ response }: HttpContextContract) {
    await QueueService.addJob(QUEUE_NAMES.ALGO_TRADING, {})
    return response.ok({ queued: true, message: 'Algo run queued' })
  }

  public async decisions({ request, response }: HttpContextContract) {
    const page = request.input('page', 1)
    const limit = request.input('limit', 50)
    const runId = request.input('run_id')
    const symbol = request.input('symbol')
    const decision = request.input('decision')

    const result = await MeilisearchService.getDecisions({
      page,
      limit,
      runId,
      symbol,
      decision,
    })

    return response.ok({
      meta: {
        total: result.total,
        per_page: result.perPage,
        current_page: result.page,
        last_page: result.lastPage,
      },
      data: result.data,
    })
  }

  public async positions({ request, response }: HttpContextContract) {
    const status = request.input('status', 'open')

    const query = AlgoPosition.query()
      .preload('ticker')
      .preload('entryTrade')
      .preload('exitTrade')
      .orderBy('created_at', 'desc')

    if (status === 'open') {
      // Show entries awaiting fill alongside real open positions
      query.whereIn('status', ['open', 'pending_entry'])
    } else if (status !== 'all') {
      query.where('status', status)
    }

    const positions = await query

    // Compute unrealized P&L for open positions
    const result = positions.map((pos) => {
      const json = pos.serialize()
      if (pos.status === 'open' || pos.status === 'pending_entry' || pos.status === 'closing') {
        const price = pos.currentPrice || pos.entryPrice
        const direction = pos.side === 'BUY' ? 1 : -1
        json.unrealized_pnl = (price - pos.entryPrice) * pos.quantity * direction
        json.unrealized_pnl_pct = ((price - pos.entryPrice) / pos.entryPrice) * direction
        json.days_held = pos.daysHeld
      }
      return json
    })

    return response.ok(result)
  }

  public async forceClose({ params, response }: HttpContextContract) {
    const pos = await AlgoPosition.find(params.id)
    if (!pos) return response.notFound({ error: 'Position not found' })
    if (pos.status !== 'open') return response.badRequest({ error: 'Position is not open' })

    pos.forceClose = true
    await pos.save()

    return response.ok({ message: 'Position marked for close on next algo run' })
  }

  public async stats({ response }: HttpContextContract) {
    const stats = await AlgoTradingService.getStats()

    // Add some extra context
    const config = await AlgoConfig.getConfig()
    const openCount = await AlgoPosition.query().where('status', 'open').count('* as total')
    const totalRuns = await MeilisearchService.countDistinctRuns()

    return response.ok({
      ...stats,
      openPositions: Number(openCount[0].$extras.total),
      algoEnabled: config.enabled,
      dryRun: config.dryRun,
      lastRunAt: config.lastRunAt,
      totalRuns,
    })
  }
}
