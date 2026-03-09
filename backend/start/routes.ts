import Route from '@ioc:Adonis/Core/Route'

Route.get('/', async () => {
  return { name: 'Syphon API', version: '1.0.0', status: 'running' }
})

Route.group(() => {
  // Dashboard
  Route.get('/dashboard', 'DashboardController.index')

  // Articles
  Route.get('/articles', 'ArticlesController.index')
  Route.get('/articles/search', 'ArticlesController.search')
  Route.get('/articles/sources', 'ArticlesController.sources')
  Route.get('/articles/:id', 'ArticlesController.show')
  Route.post('/articles/scrape', 'ArticlesController.triggerScrape')
  Route.post('/articles/analyze', 'ArticlesController.triggerAnalysis')

  // Tickers
  Route.get('/tickers', 'TickersController.index')
  Route.get('/tickers/search', 'TickersController.search')
  Route.get('/tickers/:symbol', 'TickersController.show')
  Route.post('/tickers', 'TickersController.add')
  Route.post('/tickers/:symbol/refresh', 'TickersController.refresh')
  Route.delete('/tickers/:symbol', 'TickersController.remove')

  // Analysis
  Route.get('/analysis', 'AnalysisController.index')
  Route.get('/analysis/stats', 'AnalysisController.stats')
  Route.get('/analysis/timeline', 'AnalysisController.timeline')
  Route.get('/analysis/:id', 'AnalysisController.show')

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

  // Logs
  Route.get('/logs', 'LogsController.index')
  Route.get('/logs/stats', 'LogsController.stats')
}).prefix('/api')
