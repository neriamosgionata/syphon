import Route from '@ioc:Adonis/Core/Route'

Route.get('/', async () => {
  return { name: 'Syphon API', version: '1.0.0', status: 'running' }
})

Route.group(() => {
  // Dashboard
  Route.get('/dashboard', 'DashboardController.index')
  Route.get('/jobs/active', 'DashboardController.activeJobs')
  Route.get('/jobs/failed', 'DashboardController.failedJobs')
  Route.post('/jobs/:queue/:id/retry', 'DashboardController.retryJob')
  Route.post('/jobs/:queue/:id/cancel', 'DashboardController.cancelJob')
  Route.delete('/jobs/:queue/:id', 'DashboardController.removeFailedJob')
  Route.post('/jobs/drain', 'DashboardController.drainQueues')
  Route.post('/prune', 'DashboardController.prune')

  // Articles
  Route.get('/articles', 'ArticlesController.index')
  Route.get('/articles/search', 'ArticlesController.search')
  Route.get('/articles/sources', 'ArticlesController.sources')
  Route.get('/articles/:id', 'ArticlesController.show')
  Route.post('/articles/scrape', 'ArticlesController.triggerScrape')
  Route.post('/articles/analyze', 'ArticlesController.triggerAnalysis')
  Route.post('/articles/backfill', 'ArticlesController.backfill')

  // Tickers
  Route.get('/tickers', 'TickersController.index')
  Route.get('/tickers/search', 'TickersController.search')
  Route.get('/tickers/:symbol', 'TickersController.show')
  Route.post('/tickers', 'TickersController.add')
  Route.post('/tickers/refresh-all', 'TickersController.refreshAll')
  Route.post('/tickers/backfill', 'TickersController.backfill')
  Route.post('/tickers/:symbol/refresh', 'TickersController.refresh')
  Route.delete('/tickers/:symbol', 'TickersController.remove')

  // Analysis
  Route.get('/analysis', 'AnalysisController.index')
  Route.get('/analysis/stats', 'AnalysisController.stats')
  Route.get('/analysis/timeline', 'AnalysisController.timeline')
  Route.get('/analysis/:id', 'AnalysisController.show')

  // Signals
  Route.get('/signals', 'SignalsController.index')

  // Quant
  Route.get('/quant/screener', 'QuantController.screener')
  Route.get('/quant/:symbol', 'QuantController.analyze')

  // Trading
  Route.get('/trading/status', 'TradingController.status')
  Route.post('/trading/connect', 'TradingController.connect')
  Route.post('/trading/disconnect', 'TradingController.disconnect')
  Route.get('/trading/account', 'TradingController.account')
  Route.get('/trading/positions', 'TradingController.positions')
  Route.get('/trading/stats', 'TradingController.stats')
  Route.get('/trading/orders', 'TradingController.index')
  Route.get('/trading/orders/:id', 'TradingController.show')
  Route.post('/trading/orders', 'TradingController.placeOrder')
  Route.post('/trading/orders/:id/cancel', 'TradingController.cancelOrder')

  // Algo Trading
  Route.get('/algo/config', 'AlgoController.getConfig')
  Route.put('/algo/config', 'AlgoController.updateConfig')
  Route.post('/algo/enable', 'AlgoController.enable')
  Route.post('/algo/disable', 'AlgoController.disable')
  Route.post('/algo/run', 'AlgoController.triggerRun')
  Route.get('/algo/decisions', 'AlgoController.decisions')
  Route.get('/algo/positions', 'AlgoController.positions')
  Route.post('/algo/positions/:id/close', 'AlgoController.forceClose')
  Route.get('/algo/stats', 'AlgoController.stats')

  // Training (NN model service proxy)
  Route.get('/training/health', 'TrainingController.health')
  Route.get('/training/config', 'TrainingController.config')
  Route.get('/training/model', 'TrainingController.modelInfo')
  Route.post('/training/predict', 'TrainingController.predict')
  Route.post('/training/predict/batch', 'TrainingController.predictBatch')
  Route.post('/training/train', 'TrainingController.startTraining')
  Route.get('/training/train/status', 'TrainingController.trainingStatus')
  Route.post('/training/backfill', 'TrainingController.startBackfill')
  Route.get('/training/backfill/status', 'TrainingController.backfillStatus')

  // Metrics
  Route.get('/metrics', 'MetricsController.index')

  // Logs
  Route.get('/logs', 'LogsController.index')
  Route.get('/logs/stats', 'LogsController.stats')

  // Notifications (SSE)
  Route.get('/notifications/stream', 'NotificationsController.stream')

  // Fast Trading (millisecond path, in-memory, WS-driven)
  Route.post('/fast/start', 'FastTradingController.start')
  Route.post('/fast/stop', 'FastTradingController.stop')
  Route.get('/fast/status', 'FastTradingController.status')
  Route.get('/fast/orders', 'FastTradingController.index')
  Route.get('/fast/orders/:clientOrderId', 'FastTradingController.show')
  Route.post('/fast/orders', 'FastTradingController.placeOrder')
  Route.post('/fast/orders/:clientOrderId/cancel', 'FastTradingController.cancelOrder')
  Route.get('/fast/prices/:symbol', 'FastTradingController.price')
  Route.post('/fast/subscribe', 'FastTradingController.subscribe')
}).prefix('/api')
