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

  public async screener({ response }: HttpContextContract) {
    const result = await QuantEngine.screener()
    return response.json(result)
  }
}
