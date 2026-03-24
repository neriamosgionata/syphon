import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import QuantEngine from 'App/Services/QuantEngine'

export default class SignalsController {
  public async index({ request }: HttpContextContract) {
    const days = Number(request.input('days', 30))
    const minArticles = Number(request.input('min_articles', 0))

    const signals = await QuantEngine.generateSignals({ days, minArticles })

    return {
      generated_at: new Date().toISOString(),
      count: signals.length,
      signals,
    }
  }
}
