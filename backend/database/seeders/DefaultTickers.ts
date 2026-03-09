import BaseSeeder from '@ioc:Adonis/Lucid/Seeder'
import QueueService, { QUEUE_NAMES } from 'App/Jobs/QueueService'

export default class DefaultTickersSeeder extends BaseSeeder {
  public async run() {
    const defaultTickers = [
      // Magnificent 7
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',

      // Big Tech & Semiconductors
      'AMD', 'INTC', 'AVGO', 'QCOM', 'TXN', 'MU', 'AMAT', 'ASML',
      'CRM', 'ORCL', 'ADBE', 'NOW', 'UBER', 'SHOP', 'SQ', 'PLTR',
      'SNOW', 'NET', 'CRWD', 'PANW', 'COIN', 'MSTR',

      // Finance & Banking
      'JPM', 'GS', 'MS', 'BAC', 'WFC', 'C', 'BLK', 'SCHW',
      'V', 'MA', 'AXP', 'PYPL',

      // Healthcare & Pharma
      'JNJ', 'UNH', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT',
      'AMGN', 'GILD', 'MRNA', 'BMY',

      // Consumer & Retail
      'WMT', 'COST', 'HD', 'NKE', 'SBUX', 'MCD', 'TGT', 'LOW',
      'AMZN', 'PG', 'KO', 'PEP',

      // Media & Entertainment
      'DIS', 'NFLX', 'CMCSA', 'WBD', 'PARA', 'SPOT', 'RBLX',

      // Industrial & Defense
      'BA', 'LMT', 'RTX', 'GE', 'CAT', 'DE', 'HON', 'MMM', 'UPS', 'FDX',

      // Energy
      'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'EOG',

      // Automotive & EV
      'F', 'GM', 'RIVN', 'LCID', 'TM', 'NIO', 'LI',

      // Telecom
      'T', 'VZ', 'TMUS',

      // Real Estate & REITs
      'AMT', 'PLD', 'SPG', 'O',

      // ETFs (major indices)
      'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'ARKK',
      'XLF', 'XLE', 'XLK', 'XLV', 'GLD', 'SLV', 'TLT',

      // Crypto-related
      'IBIT', 'MARA', 'RIOT',

      // Chinese Tech ADRs
      'BABA', 'JD', 'PDD', 'BIDU',
    ]

    const unique = [...new Set(defaultTickers)]

    await QueueService.addJob(QUEUE_NAMES.FETCH_TICKER, {
      symbols: unique,
      syncHistory: false,
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      timeout: 600000,
    })

    console.log(`Queued bulk sync for ${unique.length} tickers`)
  }
}
