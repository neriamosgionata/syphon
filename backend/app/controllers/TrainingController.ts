import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'

/**
 * Proxies requests to the Python training API service.
 * All endpoints gracefully handle the training service being unavailable.
 */
export default class TrainingController {
  private get apiUrl(): string {
    return env.get('TRAINING_API_URL', '')
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

  public async health({ response }: HttpContext) {
    try {
      const data = await this.proxy('/health')
      return response.json(data)
    } catch (err) {
      logger.warn('[Training] Health check failed: %s', (err as Error).message)
      return response.json({ status: 'offline', error: (err as Error).message })
    }
  }

  public async config({ response }: HttpContext) {
    try {
      const data = await this.proxy('/config')
      return response.json(data)
    } catch (err) {
      return response.json({ error: (err as Error).message })
    }
  }

  public async modelInfo({ response }: HttpContext) {
    try {
      const data = await this.proxy('/model/info')
      return response.json(data)
    } catch (err) {
      return response.json({ error: (err as Error).message, model_loaded: false })
    }
  }

  public async predict({ request, response }: HttpContext) {
    try {
      const body = request.only(['pair'])
      const data = await this.proxy('/predict', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: (err as Error).message })
    }
  }

  public async predictBatch({ request, response }: HttpContext) {
    try {
      const body = request.only(['pairs'])
      const data = await this.proxy('/predict/batch', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: (err as Error).message })
    }
  }

  public async startTraining({ request, response }: HttpContext) {
    try {
      const body = request.only(['pairs', 'epochs', 'batch_size', 'learning_rate'])
      const data = await this.proxy('/train', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: (err as Error).message })
    }
  }

  public async trainingStatus({ response }: HttpContext) {
    try {
      const data = await this.proxy('/train/status')
      return response.json(data)
    } catch (err) {
      return response.json({ running: false, error: (err as Error).message })
    }
  }

  public async startBackfill({ request, response }: HttpContext) {
    try {
      const body = request.only(['pairs', 'days'])
      const data = await this.proxy('/backfill', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return response.json(data)
    } catch (err) {
      return response.serviceUnavailable({ error: (err as Error).message })
    }
  }

  public async backfillStatus({ response }: HttpContext) {
    try {
      const data = await this.proxy('/backfill/status')
      return response.json(data)
    } catch (err) {
      return response.json({ running: false, error: (err as Error).message })
    }
  }
}
