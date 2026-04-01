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

    for (const field of allowedFields) {
      // Convert camelCase from body to snake_case keys too
      const snakeField = field.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
      const value = body[field] ?? body[snakeField]
      if (value !== undefined) {
        ;(config as any)[field] = value
      }
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

    if (status !== 'all') {
      query.where('status', status)
    }

    const positions = await query

    // Compute unrealized P&L for open positions
    const result = positions.map((pos) => {
      const json = pos.serialize()
      if (pos.status === 'open' || pos.status === 'closing') {
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
