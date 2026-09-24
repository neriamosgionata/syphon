/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string.optional(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_NAME: Env.schema.string(),
  APP_URL: Env.schema.string.optional(),

  // Database
  DB_CONNECTION: Env.schema.enum(['sqlite', 'mysql'] as const),
  SQLITE_FILENAME: Env.schema.string.optional(),
  MYSQL_HOST: Env.schema.string.optional(),
  MYSQL_PORT: Env.schema.number.optional(),
  MYSQL_USER: Env.schema.string.optional(),
  MYSQL_PASSWORD: Env.schema.string.optional(),
  MYSQL_DB_NAME: Env.schema.string.optional(),

  // Redis
  REDIS_CONNECTION: Env.schema.enum(['local'] as const),
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.string.optional(),

  // Meilisearch
  MEILI_URL: Env.schema.string.optional(),
  MEILI_KEY: Env.schema.string.optional(),
  SCRAPE_INTERVAL_MINUTES: Env.schema.number.optional(),
  ANALYSIS_BATCH_SIZE: Env.schema.number.optional(),

  // IBKR
  IB_HOST: Env.schema.string.optional(),
  IB_PORT: Env.schema.number.optional(),
  IB_CLIENT_ID: Env.schema.number.optional(),

  // Kraken
  KRAKEN_API_KEY: Env.schema.string.optional(),
  KRAKEN_API_SECRET: Env.schema.string.optional(),
  // Dedicated Earn credentials (Earn Funds + Query Funds only) — never the
  // spot trading key. The Earn client refuses to sign without them.
  KRAKEN_EARN_KEY: Env.schema.string.optional(),
  KRAKEN_EARN_SECRET: Env.schema.string.optional(),

  // Yield line (Kraken Earn). YIELD_LIVE unset = observe only.
  YIELD_LIVE: Env.schema.boolean.optional(),
  YIELD_ALLOWLIST: Env.schema.string.optional(),
  YIELD_BUFFER_PCT: Env.schema.number.optional(),
  YIELD_MIN_ALLOCATION_USD: Env.schema.number.optional(),
  YIELD_APY_FLOOR_PCT: Env.schema.number.optional(),
  YIELD_APY_CEILING_PCT: Env.schema.number.optional(),
  YIELD_MAX_PER_ASSET_USD: Env.schema.number.optional(),
  YIELD_MAX_TOTAL_USD: Env.schema.number.optional(),
  KRAKEN_FUTURES_KEY: Env.schema.string.optional(),
  KRAKEN_FUTURES_SECRET: Env.schema.string.optional(),

  // GDELT BigQuery
  GCP_PROJECT_ID: Env.schema.string.optional(),
  GOOGLE_APPLICATION_CREDENTIALS: Env.schema.string.optional(),

  // Training
  TRAINING_API_URL: Env.schema.string.optional(),
})