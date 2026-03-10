/**
 * Finance data provider facade.
 *
 * Set the env variable FINANCE_PROVIDER to choose the data source:
 *   - "google"  → Google Finance scraper (default)
 *   - "yahoo"   → Yahoo Finance API
 */
import Env from '@ioc:Adonis/Core/Env'
import GoogleFinanceService from './GoogleFinanceService'
import YahooFinanceService from './YahooFinanceService'

const provider = (Env.get('FINANCE_PROVIDER', 'google') as string).toLowerCase()

const FinanceService = provider === 'yahoo' ? YahooFinanceService : GoogleFinanceService

export default FinanceService
