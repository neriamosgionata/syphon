import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import QuantEngine from 'App/Services/QuantEngine'

export default class QuantController {
  public async analyze({ params, response }: HttpContextContract) {
    const analysis = await QuantEngine.analyzeTicker(params.symbol)
    if (!analysis) {
      return response.notFound({ error: `No data for ${params.symbol}` })
    }
    return response.json(analysis)
  }

  public async screener({ request, response }: HttpContextContract) {
    const days = Number(request.input('days', 365))
    const minArticles = Number(request.input('min_articles', 0))
    const result = await QuantEngine.screener({ days, minArticles })
    return response.json(result)
  }
}
