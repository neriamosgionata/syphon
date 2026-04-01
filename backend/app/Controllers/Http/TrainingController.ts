import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import Env from '@ioc:Adonis/Core/Env'
import Logger from '@ioc:Adonis/Core/Logger'

/**
 * Proxies requests to the Python training API service.
 * All endpoints gracefully handle the training service being unavailable.
 */
export default class TrainingController {
  private get apiUrl(): string {
    return Env.get('TRAINING_API_URL', '')
  }

  private async proxy(path: string, opts?: RequestInit): Promise<any> {
    if (!this.apiUrl) {
      return { error: 'TRAINING_API_URL not configured', status: 'not_configured' }
    }

    const resp = await fetch(`${this.apiUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
      signal: AbortSignal.timeout(30000),
      ...opts,
    })

    return resp.json()
  }

  public async health({ response }: HttpContextContract) {
    try {
      const data = await this.proxy('/health')
      return response.json(data)
    } catch (err) {
      Logger.warn('[Training] Health check failed: %s', err.message)
      return response.json({ status: 'offline', error: err.message })
    }
  }

  public async config({ response }: HttpContextContract) {
    try {
      const data = await this.proxy('/config')
      return response.json(data)
    } catch (err) {
      return response.json({ error: err.message })
    }
  }

  public async modelInfo({ response }: HttpContextContract) {
    try {
      const data = await this.proxy('/model/info')
      return response.json(data)
    } catch (err) {
      return response.json({ error: err.message, model_loaded: false })
    }
  }

  public async predict({ request, response }: HttpContextContract) {
    try {
      const body = request.only(['pair'])
      const data = await this.proxy('/predict', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: err.message })
    }
  }

  public async predictBatch({ request, response }: HttpContextContract) {
    try {
      const body = request.only(['pairs'])
      const data = await this.proxy('/predict/batch', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: err.message })
    }
  }

  public async startTraining({ request, response }: HttpContextContract) {
    try {
      const body = request.only(['pairs', 'epochs', 'batch_size', 'learning_rate'])
      const data = await this.proxy('/train', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: err.message })
    }
  }

  public async trainingStatus({ response }: HttpContextContract) {
    try {
      const data = await this.proxy('/train/status')
      return response.json(data)
    } catch (err) {
      return response.json({ running: false, error: err.message })
    }
  }

  public async startBackfill({ request, response }: HttpContextContract) {
    try {
      const body = request.only(['pairs', 'days'])
      const data = await this.proxy('/backfill', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: err.message })
    }
  }

  public async backfillStatus({ response }: HttpContextContract) {
    try {
      const data = await this.proxy('/backfill/status')
      return response.json(data)
    } catch (err) {
      return response.json({ running: false, error: err.message })
    }
  }
}
