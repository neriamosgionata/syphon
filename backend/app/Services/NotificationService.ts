import { EventEmitter } from 'events'
import Logger from '@ioc:Adonis/Core/Logger'

export interface TickerMatchNotification {
  type: 'ticker_match'
  articleId: number
  articleTitle: string
  articleUrl: string | null
  sourceName: string | null
  ticker: {
    symbol: string
    name: string
    currentPrice: number | null
  }
  sentiment: string
  sentimentScore: number
  relevanceScore: number
  confidence: number
  keywords: string[] | null
  timestamp: string
}

export interface ScrapeCompleteNotification {
  type: 'scrape_complete'
  totalSaved: number
  sourcesProcessed: number
  timestamp: string
}

export interface OrderUpdateNotification {
  type: 'order_update'
  tradeId: number
  symbol: string
  side: string
  status: string
  quantity: number
  fillPrice: number | null
  timestamp: string
}

export type AppNotification =
  | TickerMatchNotification
  | ScrapeCompleteNotification
  | OrderUpdateNotification

class NotificationService {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  public emit(notification: AppNotification) {
    Logger.debug('[Notifications] Emitting %s', notification.type)
    this.emitter.emit('notification', notification)
  }

  public subscribe(listener: (notification: AppNotification) => void) {
    this.emitter.on('notification', listener)
    return () => {
      this.emitter.off('notification', listener)
    }
  }
}

export default new NotificationService()
