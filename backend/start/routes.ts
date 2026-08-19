import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'

router.get('/', async () => {
  return { name: 'Syphon API', version: '1.0.0', status: 'running' }
})

router
  .group(() => {
    // Dashboard
    router.get('/dashboard', [controllers.Dashboard, 'index'])
    router.get('/jobs/active', [controllers.Dashboard, 'activeJobs'])
    router.get('/jobs/failed', [controllers.Dashboard, 'failedJobs'])
    router.post('/jobs/:queue/:id/retry', [controllers.Dashboard, 'retryJob'])
    router.post('/jobs/:queue/:id/cancel', [controllers.Dashboard, 'cancelJob'])
    router.delete('/jobs/:queue/:id', [controllers.Dashboard, 'removeFailedJob'])
    router.post('/jobs/drain', [controllers.Dashboard, 'drainQueues'])
    router.post('/prune', [controllers.Dashboard, 'prune'])

    // Articles
    router.get('/articles', [controllers.Articles, 'index'])
    router.get('/articles/search', [controllers.Articles, 'search'])
    router.get('/articles/sources', [controllers.Articles, 'sources'])
    router.get('/articles/:id', [controllers.Articles, 'show'])
    router.post('/articles/scrape', [controllers.Articles, 'triggerScrape'])
    router.post('/articles/analyze', [controllers.Articles, 'triggerAnalysis'])
    router.post('/articles/backfill', [controllers.Articles, 'backfill'])

    // Tickers
    router.get('/tickers', [controllers.Tickers, 'index'])
    router.get('/tickers/search', [controllers.Tickers, 'search'])
    router.get('/tickers/:symbol', [controllers.Tickers, 'show'])
    router.post('/tickers', [controllers.Tickers, 'add'])
    router.post('/tickers/refresh-all', [controllers.Tickers, 'refreshAll'])
    router.post('/tickers/backfill', [controllers.Tickers, 'backfill'])
    router.post('/tickers/:symbol/refresh', [controllers.Tickers, 'refresh'])
    router.delete('/tickers/:symbol', [controllers.Tickers, 'remove'])

    // Analysis
    router.get('/analysis', [controllers.Analysis, 'index'])
    router.get('/analysis/stats', [controllers.Analysis, 'stats'])
    router.get('/analysis/timeline', [controllers.Analysis, 'timeline'])
    router.get('/analysis/:id', [controllers.Analysis, 'show'])

    // Signals
    router.get('/signals', [controllers.Signals, 'index'])

    // Quant
    router.get('/quant/screener', [controllers.Quant, 'screener'])
    router.get('/quant/:symbol', [controllers.Quant, 'analyze'])

    // Trading
    router.get('/trading/status', [controllers.Trading, 'status'])
    router.post('/trading/connect', [controllers.Trading, 'connect'])
    router.post('/trading/disconnect', [controllers.Trading, 'disconnect'])
    router.get('/trading/account', [controllers.Trading, 'account'])
    router.get('/trading/positions', [controllers.Trading, 'positions'])
    router.get('/trading/stats', [controllers.Trading, 'stats'])
    router.get('/trading/orders', [controllers.Trading, 'index'])
    router.get('/trading/orders/:id', [controllers.Trading, 'show'])
    router.post('/trading/orders', [controllers.Trading, 'placeOrder'])
    router.post('/trading/orders/:id/cancel', [controllers.Trading, 'cancelOrder'])

    // Algo Trading
    router.get('/algo/config', [controllers.Algo, 'getConfig'])
    router.put('/algo/config', [controllers.Algo, 'updateConfig'])
    router.post('/algo/enable', [controllers.Algo, 'enable'])
    router.post('/algo/disable', [controllers.Algo, 'disable'])
    router.get('/algo/fast/status', [controllers.Algo, 'fastStatus'])
    router.get('/algo/decisions', [controllers.Algo, 'decisions'])
    router.get('/algo/positions', [controllers.Algo, 'positions'])
    router.post('/algo/positions/:id/close', [controllers.Algo, 'forceClose'])
    router.get('/algo/stats', [controllers.Algo, 'stats'])

    // Training (NN model service proxy)
    router.get('/training/health', [controllers.Training, 'health'])
    router.get('/training/config', [controllers.Training, 'config'])
    router.get('/training/model', [controllers.Training, 'modelInfo'])
    router.post('/training/predict', [controllers.Training, 'predict'])
    router.post('/training/predict/batch', [controllers.Training, 'predictBatch'])
    router.post('/training/train', [controllers.Training, 'startTraining'])
    router.get('/training/train/status', [controllers.Training, 'trainingStatus'])
    router.post('/training/backfill', [controllers.Training, 'startBackfill'])
    router.get('/training/backfill/status', [controllers.Training, 'backfillStatus'])

    // Metrics
    router.get('/metrics', [controllers.Metrics, 'index'])

    // Logs
    router.get('/logs', [controllers.Logs, 'index'])
    router.get('/logs/stats', [controllers.Logs, 'stats'])

    // Notifications (SSE)
    router.get('/notifications/stream', [controllers.Notifications, 'stream'])
  })
  .prefix('/api')