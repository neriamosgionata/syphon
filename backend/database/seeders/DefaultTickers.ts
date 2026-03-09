import BaseSeeder from '@ioc:Adonis/Lucid/Seeder'
import Ticker from 'App/Models/Ticker'

export default class DefaultTickersSeeder extends BaseSeeder {
  public async run() {
    const defaultTickers = [
      // Magnificent 7
      { symbol: 'AAPL', name: 'Apple Inc.' },
      { symbol: 'MSFT', name: 'Microsoft Corporation' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.' },
      { symbol: 'AMZN', name: 'Amazon.com Inc.' },
      { symbol: 'NVDA', name: 'NVIDIA Corporation' },
      { symbol: 'META', name: 'Meta Platforms Inc.' },
      { symbol: 'TSLA', name: 'Tesla Inc.' },

      // Big Tech & Semiconductors
      { symbol: 'AMD', name: 'Advanced Micro Devices Inc.' },
      { symbol: 'INTC', name: 'Intel Corporation' },
      { symbol: 'AVGO', name: 'Broadcom Inc.' },
      { symbol: 'QCOM', name: 'Qualcomm Inc.' },
      { symbol: 'TXN', name: 'Texas Instruments Inc.' },
      { symbol: 'MU', name: 'Micron Technology Inc.' },
      { symbol: 'AMAT', name: 'Applied Materials Inc.' },
      { symbol: 'ASML', name: 'ASML Holding NV' },
      { symbol: 'CRM', name: 'Salesforce Inc.' },
      { symbol: 'ORCL', name: 'Oracle Corporation' },
      { symbol: 'ADBE', name: 'Adobe Inc.' },
      { symbol: 'NOW', name: 'ServiceNow Inc.' },
      { symbol: 'UBER', name: 'Uber Technologies Inc.' },
      { symbol: 'SHOP', name: 'Shopify Inc.' },
      { symbol: 'SQ', name: 'Block Inc.' },
      { symbol: 'PLTR', name: 'Palantir Technologies Inc.' },
      { symbol: 'SNOW', name: 'Snowflake Inc.' },
      { symbol: 'NET', name: 'Cloudflare Inc.' },
      { symbol: 'CRWD', name: 'CrowdStrike Holdings Inc.' },
      { symbol: 'PANW', name: 'Palo Alto Networks Inc.' },
      { symbol: 'COIN', name: 'Coinbase Global Inc.' },
      { symbol: 'MSTR', name: 'MicroStrategy Inc.' },

      // Finance & Banking
      { symbol: 'JPM', name: 'JPMorgan Chase & Co.' },
      { symbol: 'GS', name: 'Goldman Sachs Group Inc.' },
      { symbol: 'MS', name: 'Morgan Stanley' },
      { symbol: 'BAC', name: 'Bank of America Corp.' },
      { symbol: 'WFC', name: 'Wells Fargo & Co.' },
      { symbol: 'C', name: 'Citigroup Inc.' },
      { symbol: 'BLK', name: 'BlackRock Inc.' },
      { symbol: 'SCHW', name: 'Charles Schwab Corp.' },
      { symbol: 'V', name: 'Visa Inc.' },
      { symbol: 'MA', name: 'Mastercard Inc.' },
      { symbol: 'AXP', name: 'American Express Co.' },
      { symbol: 'PYPL', name: 'PayPal Holdings Inc.' },

      // Healthcare & Pharma
      { symbol: 'JNJ', name: 'Johnson & Johnson' },
      { symbol: 'UNH', name: 'UnitedHealth Group Inc.' },
      { symbol: 'PFE', name: 'Pfizer Inc.' },
      { symbol: 'ABBV', name: 'AbbVie Inc.' },
      { symbol: 'MRK', name: 'Merck & Co. Inc.' },
      { symbol: 'LLY', name: 'Eli Lilly and Co.' },
      { symbol: 'TMO', name: 'Thermo Fisher Scientific Inc.' },
      { symbol: 'ABT', name: 'Abbott Laboratories' },
      { symbol: 'AMGN', name: 'Amgen Inc.' },
      { symbol: 'GILD', name: 'Gilead Sciences Inc.' },
      { symbol: 'MRNA', name: 'Moderna Inc.' },
      { symbol: 'BMY', name: 'Bristol-Myers Squibb Co.' },

      // Consumer & Retail
      { symbol: 'WMT', name: 'Walmart Inc.' },
      { symbol: 'COST', name: 'Costco Wholesale Corp.' },
      { symbol: 'HD', name: 'Home Depot Inc.' },
      { symbol: 'NKE', name: 'Nike Inc.' },
      { symbol: 'SBUX', name: 'Starbucks Corp.' },
      { symbol: 'MCD', name: 'McDonalds Corp.' },
      { symbol: 'TGT', name: 'Target Corp.' },
      { symbol: 'LOW', name: 'Lowes Companies Inc.' },
      { symbol: 'PG', name: 'Procter & Gamble Co.' },
      { symbol: 'KO', name: 'Coca-Cola Co.' },
      { symbol: 'PEP', name: 'PepsiCo Inc.' },

      // Media & Entertainment
      { symbol: 'DIS', name: 'Walt Disney Co.' },
      { symbol: 'NFLX', name: 'Netflix Inc.' },
      { symbol: 'CMCSA', name: 'Comcast Corp.' },
      { symbol: 'WBD', name: 'Warner Bros. Discovery Inc.' },
      { symbol: 'PARA', name: 'Paramount Global' },
      { symbol: 'SPOT', name: 'Spotify Technology SA' },
      { symbol: 'RBLX', name: 'Roblox Corp.' },

      // Industrial & Defense
      { symbol: 'BA', name: 'Boeing Co.' },
      { symbol: 'LMT', name: 'Lockheed Martin Corp.' },
      { symbol: 'RTX', name: 'RTX Corporation' },
      { symbol: 'GE', name: 'GE Aerospace' },
      { symbol: 'CAT', name: 'Caterpillar Inc.' },
      { symbol: 'DE', name: 'Deere & Co.' },
      { symbol: 'HON', name: 'Honeywell International Inc.' },
      { symbol: 'MMM', name: '3M Company' },
      { symbol: 'UPS', name: 'United Parcel Service Inc.' },
      { symbol: 'FDX', name: 'FedEx Corp.' },

      // Energy
      { symbol: 'XOM', name: 'Exxon Mobil Corp.' },
      { symbol: 'CVX', name: 'Chevron Corp.' },
      { symbol: 'COP', name: 'ConocoPhillips' },
      { symbol: 'SLB', name: 'Schlumberger NV' },
      { symbol: 'OXY', name: 'Occidental Petroleum Corp.' },
      { symbol: 'EOG', name: 'EOG Resources Inc.' },

      // Automotive & EV
      { symbol: 'F', name: 'Ford Motor Co.' },
      { symbol: 'GM', name: 'General Motors Co.' },
      { symbol: 'RIVN', name: 'Rivian Automotive Inc.' },
      { symbol: 'LCID', name: 'Lucid Group Inc.' },
      { symbol: 'TM', name: 'Toyota Motor Corp.' },
      { symbol: 'NIO', name: 'NIO Inc.' },
      { symbol: 'LI', name: 'Li Auto Inc.' },

      // Telecom
      { symbol: 'T', name: 'AT&T Inc.' },
      { symbol: 'VZ', name: 'Verizon Communications Inc.' },
      { symbol: 'TMUS', name: 'T-Mobile US Inc.' },

      // Real Estate & REITs
      { symbol: 'AMT', name: 'American Tower Corp.' },
      { symbol: 'PLD', name: 'Prologis Inc.' },
      { symbol: 'SPG', name: 'Simon Property Group Inc.' },
      { symbol: 'O', name: 'Realty Income Corp.' },

      // ETFs (major indices)
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
      { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
      { symbol: 'DIA', name: 'SPDR Dow Jones ETF' },
      { symbol: 'IWM', name: 'iShares Russell 2000 ETF' },
      { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' },
      { symbol: 'VOO', name: 'Vanguard S&P 500 ETF' },
      { symbol: 'ARKK', name: 'ARK Innovation ETF' },
      { symbol: 'XLF', name: 'Financial Select Sector SPDR' },
      { symbol: 'XLE', name: 'Energy Select Sector SPDR' },
      { symbol: 'XLK', name: 'Technology Select Sector SPDR' },
      { symbol: 'XLV', name: 'Health Care Select Sector SPDR' },
      { symbol: 'GLD', name: 'SPDR Gold Shares' },
      { symbol: 'SLV', name: 'iShares Silver Trust' },
      { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF' },

      // Crypto-related
      { symbol: 'IBIT', name: 'iShares Bitcoin Trust' },
      { symbol: 'MARA', name: 'Marathon Digital Holdings Inc.' },
      { symbol: 'RIOT', name: 'Riot Platforms Inc.' },

      // Chinese Tech ADRs
      { symbol: 'BABA', name: 'Alibaba Group Holding Ltd.' },
      { symbol: 'JD', name: 'JD.com Inc.' },
      { symbol: 'PDD', name: 'PDD Holdings Inc.' },
      { symbol: 'BIDU', name: 'Baidu Inc.' },
    ]

    await Ticker.updateOrCreateMany('symbol', defaultTickers.map((t) => ({
      ...t,
      isActive: true,
    })))

    console.log(`Seeded ${defaultTickers.length} default tickers`)
  }
}
