import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'

export default class CorsMiddleware {
  public async handle({ request, response }: HttpContextContract, next: () => Promise<void>) {
    response.header('Access-Control-Allow-Origin', request.header('origin') || '*')
    response.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
    response.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With')
    response.header('Access-Control-Allow-Credentials', 'true')
    response.header('Access-Control-Max-Age', '90')

    if (request.method() === 'OPTIONS') {
      response.status(204)
      return
    }

    await next()
  }
}
