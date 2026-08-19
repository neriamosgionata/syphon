import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'dashboard.index': { paramsTuple?: []; params?: {} }
    'dashboard.active_jobs': { paramsTuple?: []; params?: {} }
    'dashboard.failed_jobs': { paramsTuple?: []; params?: {} }
    'dashboard.retry_job': { paramsTuple: [ParamValue,ParamValue]; params: {'queue': ParamValue,'id': ParamValue} }
    'dashboard.cancel_job': { paramsTuple: [ParamValue,ParamValue]; params: {'queue': ParamValue,'id': ParamValue} }
    'dashboard.remove_failed_job': { paramsTuple: [ParamValue,ParamValue]; params: {'queue': ParamValue,'id': ParamValue} }
    'dashboard.drain_queues': { paramsTuple?: []; params?: {} }
    'dashboard.prune': { paramsTuple?: []; params?: {} }
    'articles.index': { paramsTuple?: []; params?: {} }
    'articles.search': { paramsTuple?: []; params?: {} }
    'articles.sources': { paramsTuple?: []; params?: {} }
    'articles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'articles.trigger_scrape': { paramsTuple?: []; params?: {} }
    'articles.trigger_analysis': { paramsTuple?: []; params?: {} }
    'articles.backfill': { paramsTuple?: []; params?: {} }
    'tickers.index': { paramsTuple?: []; params?: {} }
    'tickers.search': { paramsTuple?: []; params?: {} }
    'tickers.show': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'tickers.add': { paramsTuple?: []; params?: {} }
    'tickers.refresh_all': { paramsTuple?: []; params?: {} }
    'tickers.backfill': { paramsTuple?: []; params?: {} }
    'tickers.refresh': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'tickers.remove': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'analysis.index': { paramsTuple?: []; params?: {} }
    'analysis.stats': { paramsTuple?: []; params?: {} }
    'analysis.timeline': { paramsTuple?: []; params?: {} }
    'analysis.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'signals.index': { paramsTuple?: []; params?: {} }
    'quant.screener': { paramsTuple?: []; params?: {} }
    'quant.analyze': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'trading.status': { paramsTuple?: []; params?: {} }
    'trading.connect': { paramsTuple?: []; params?: {} }
    'trading.disconnect': { paramsTuple?: []; params?: {} }
    'trading.account': { paramsTuple?: []; params?: {} }
    'trading.positions': { paramsTuple?: []; params?: {} }
    'trading.stats': { paramsTuple?: []; params?: {} }
    'trading.index': { paramsTuple?: []; params?: {} }
    'trading.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'trading.place_order': { paramsTuple?: []; params?: {} }
    'trading.cancel_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'algo.get_config': { paramsTuple?: []; params?: {} }
    'algo.update_config': { paramsTuple?: []; params?: {} }
    'algo.enable': { paramsTuple?: []; params?: {} }
    'algo.disable': { paramsTuple?: []; params?: {} }
    'algo.fast_status': { paramsTuple?: []; params?: {} }
    'algo.decisions': { paramsTuple?: []; params?: {} }
    'algo.positions': { paramsTuple?: []; params?: {} }
    'algo.force_close': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'algo.stats': { paramsTuple?: []; params?: {} }
    'training.health': { paramsTuple?: []; params?: {} }
    'training.config': { paramsTuple?: []; params?: {} }
    'training.model_info': { paramsTuple?: []; params?: {} }
    'training.predict': { paramsTuple?: []; params?: {} }
    'training.predict_batch': { paramsTuple?: []; params?: {} }
    'training.start_training': { paramsTuple?: []; params?: {} }
    'training.training_status': { paramsTuple?: []; params?: {} }
    'training.start_backfill': { paramsTuple?: []; params?: {} }
    'training.backfill_status': { paramsTuple?: []; params?: {} }
    'metrics.index': { paramsTuple?: []; params?: {} }
    'logs.index': { paramsTuple?: []; params?: {} }
    'logs.stats': { paramsTuple?: []; params?: {} }
    'notifications.stream': { paramsTuple?: []; params?: {} }
  }
  GET: {
    'dashboard.index': { paramsTuple?: []; params?: {} }
    'dashboard.active_jobs': { paramsTuple?: []; params?: {} }
    'dashboard.failed_jobs': { paramsTuple?: []; params?: {} }
    'articles.index': { paramsTuple?: []; params?: {} }
    'articles.search': { paramsTuple?: []; params?: {} }
    'articles.sources': { paramsTuple?: []; params?: {} }
    'articles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'tickers.index': { paramsTuple?: []; params?: {} }
    'tickers.search': { paramsTuple?: []; params?: {} }
    'tickers.show': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'analysis.index': { paramsTuple?: []; params?: {} }
    'analysis.stats': { paramsTuple?: []; params?: {} }
    'analysis.timeline': { paramsTuple?: []; params?: {} }
    'analysis.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'signals.index': { paramsTuple?: []; params?: {} }
    'quant.screener': { paramsTuple?: []; params?: {} }
    'quant.analyze': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'trading.status': { paramsTuple?: []; params?: {} }
    'trading.account': { paramsTuple?: []; params?: {} }
    'trading.positions': { paramsTuple?: []; params?: {} }
    'trading.stats': { paramsTuple?: []; params?: {} }
    'trading.index': { paramsTuple?: []; params?: {} }
    'trading.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'algo.get_config': { paramsTuple?: []; params?: {} }
    'algo.fast_status': { paramsTuple?: []; params?: {} }
    'algo.decisions': { paramsTuple?: []; params?: {} }
    'algo.positions': { paramsTuple?: []; params?: {} }
    'algo.stats': { paramsTuple?: []; params?: {} }
    'training.health': { paramsTuple?: []; params?: {} }
    'training.config': { paramsTuple?: []; params?: {} }
    'training.model_info': { paramsTuple?: []; params?: {} }
    'training.training_status': { paramsTuple?: []; params?: {} }
    'training.backfill_status': { paramsTuple?: []; params?: {} }
    'metrics.index': { paramsTuple?: []; params?: {} }
    'logs.index': { paramsTuple?: []; params?: {} }
    'logs.stats': { paramsTuple?: []; params?: {} }
    'notifications.stream': { paramsTuple?: []; params?: {} }
  }
  HEAD: {
    'dashboard.index': { paramsTuple?: []; params?: {} }
    'dashboard.active_jobs': { paramsTuple?: []; params?: {} }
    'dashboard.failed_jobs': { paramsTuple?: []; params?: {} }
    'articles.index': { paramsTuple?: []; params?: {} }
    'articles.search': { paramsTuple?: []; params?: {} }
    'articles.sources': { paramsTuple?: []; params?: {} }
    'articles.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'tickers.index': { paramsTuple?: []; params?: {} }
    'tickers.search': { paramsTuple?: []; params?: {} }
    'tickers.show': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'analysis.index': { paramsTuple?: []; params?: {} }
    'analysis.stats': { paramsTuple?: []; params?: {} }
    'analysis.timeline': { paramsTuple?: []; params?: {} }
    'analysis.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'signals.index': { paramsTuple?: []; params?: {} }
    'quant.screener': { paramsTuple?: []; params?: {} }
    'quant.analyze': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'trading.status': { paramsTuple?: []; params?: {} }
    'trading.account': { paramsTuple?: []; params?: {} }
    'trading.positions': { paramsTuple?: []; params?: {} }
    'trading.stats': { paramsTuple?: []; params?: {} }
    'trading.index': { paramsTuple?: []; params?: {} }
    'trading.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'algo.get_config': { paramsTuple?: []; params?: {} }
    'algo.fast_status': { paramsTuple?: []; params?: {} }
    'algo.decisions': { paramsTuple?: []; params?: {} }
    'algo.positions': { paramsTuple?: []; params?: {} }
    'algo.stats': { paramsTuple?: []; params?: {} }
    'training.health': { paramsTuple?: []; params?: {} }
    'training.config': { paramsTuple?: []; params?: {} }
    'training.model_info': { paramsTuple?: []; params?: {} }
    'training.training_status': { paramsTuple?: []; params?: {} }
    'training.backfill_status': { paramsTuple?: []; params?: {} }
    'metrics.index': { paramsTuple?: []; params?: {} }
    'logs.index': { paramsTuple?: []; params?: {} }
    'logs.stats': { paramsTuple?: []; params?: {} }
    'notifications.stream': { paramsTuple?: []; params?: {} }
  }
  POST: {
    'dashboard.retry_job': { paramsTuple: [ParamValue,ParamValue]; params: {'queue': ParamValue,'id': ParamValue} }
    'dashboard.cancel_job': { paramsTuple: [ParamValue,ParamValue]; params: {'queue': ParamValue,'id': ParamValue} }
    'dashboard.drain_queues': { paramsTuple?: []; params?: {} }
    'dashboard.prune': { paramsTuple?: []; params?: {} }
    'articles.trigger_scrape': { paramsTuple?: []; params?: {} }
    'articles.trigger_analysis': { paramsTuple?: []; params?: {} }
    'articles.backfill': { paramsTuple?: []; params?: {} }
    'tickers.add': { paramsTuple?: []; params?: {} }
    'tickers.refresh_all': { paramsTuple?: []; params?: {} }
    'tickers.backfill': { paramsTuple?: []; params?: {} }
    'tickers.refresh': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
    'trading.connect': { paramsTuple?: []; params?: {} }
    'trading.disconnect': { paramsTuple?: []; params?: {} }
    'trading.place_order': { paramsTuple?: []; params?: {} }
    'trading.cancel_order': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'algo.enable': { paramsTuple?: []; params?: {} }
    'algo.disable': { paramsTuple?: []; params?: {} }
    'algo.force_close': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'training.predict': { paramsTuple?: []; params?: {} }
    'training.predict_batch': { paramsTuple?: []; params?: {} }
    'training.start_training': { paramsTuple?: []; params?: {} }
    'training.start_backfill': { paramsTuple?: []; params?: {} }
  }
  DELETE: {
    'dashboard.remove_failed_job': { paramsTuple: [ParamValue,ParamValue]; params: {'queue': ParamValue,'id': ParamValue} }
    'tickers.remove': { paramsTuple: [ParamValue]; params: {'symbol': ParamValue} }
  }
  PUT: {
    'algo.update_config': { paramsTuple?: []; params?: {} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}