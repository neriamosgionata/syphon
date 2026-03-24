import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import TradingSignalService from 'App/Services/TradingSignalService'

export default class SignalsController {
  public async index({ request }: HttpContextContract) {
    const days = Number(request.input('days', 30))
    const minArticles = Number(request.input('min_articles', 0))

    const signals = await TradingSignalService.generateSignals({ days, minArticles })

    return {
      generated_at: new Date().toISOString(),
      count: signals.length,
      signals,
    }
  }
}
