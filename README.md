# Syphon

Real-time financial intelligence platform that scrapes news, runs NLP sentiment analysis, computes quantitative trading signals, trains neural network models, and executes automated trades across equities (IBKR) and crypto (Kraken).

---

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Frontend](#frontend)
- [Backend Services](#backend-services)
- [Background Jobs & Cron](#background-jobs--cron)
- [Data Flow](#data-flow)
- [Data Storage](#data-storage)
- [QuantEngine](#quantengine)
- [Algo Trading Engine](#algo-trading-engine)
- [Neural Network (Training Service)](#neural-network-training-service)
- [Seeded Tickers](#seeded-tickers)
- [Development](#development)
- [Deployment](#deployment)

---

## Architecture

```
syphon/
├── backend/          AdonisJS 5 REST API + BullMQ workers
├── frontend/         SvelteKit 5 SPA (Svelte 5 runes)
├── training/         PyTorch transformer model (FastAPI inference server)
└── docker-compose.yml
```

### Infrastructure (Docker Compose)

| Service | Image | Port | Memory | Purpose |
|---------|-------|------|--------|---------|
| MariaDB 11 | `mariadb:11` | 3307 | 512M | Relational store (tickers, trades, configs) |
| Redis 7 | `redis:7-alpine` | 6379 | 96M | BullMQ broker, caching, ID generation |
| Meilisearch | `getmeili/meilisearch:latest` | 7700 | 128M | Primary store for articles, analyses, snapshots, decisions + full-text search |
| Trainer | `./training` (Python 3.11) | 8000 | 512M | PyTorch inference server |

### Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Backend framework | AdonisJS | 5.9.0 |
| ORM | Lucid (MySQL 2 driver) | 18.4.2 |
| Job queue | BullMQ | 5.70.4 |
| Frontend framework | SvelteKit | 2.53.4 |
| UI library | Svelte 5 (runes) | 5.53.7 |
| Charts | Chart.js (direct, no wrapper) | 4.5.1 |
| Build tool | Vite | 7.3.1 |
| Search engine | Meilisearch | latest |
| NLP | natural (AFINN + financial lexicon) | 8.1.1 |
| ML framework | PyTorch | >= 2.2.0 |
| Inference API | FastAPI + Uvicorn | >= 0.110.0 |
| IBKR broker | @stoqey/ib | 1.5.3 |
| Kraken broker | Raw REST + HMAC-SHA512 | - |

### Data Storage Split

- **Meilisearch** (bulk, searchable): articles, analyses, ticker snapshots, algo decisions, application logs
- **MariaDB** (small, relational, ACID): tickers, scrape sources, trades, algo configs, algo positions

---

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker & Docker Compose
- Python 3.10+ (training service only)

### 1. Start Infrastructure

```bash
docker compose up -d mariadb redis meilisearch
docker compose ps   # wait for all services to be healthy
```

### 2. Backend Setup

```bash
cd backend
cp .env.example .env       # or use existing .env
npm install --legacy-peer-deps
node ace migration:run
node ace db:seed             # seeds 122 default tickers
node ace serve --watch       # starts on http://localhost:3333
```

In a separate terminal, start the BullMQ workers:

```bash
cd backend
node ace queue:listen
```

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev                  # starts on http://localhost:5173
```

### 4. Training Service (Optional)

Locally:

```bash
cd training
pip install -r requirements.txt
python scripts/backfill.py --pair XXBTZUSD --days 90
python scripts/train.py --config config.yaml
uvicorn src.inference.server:app --host 0.0.0.0 --port 8000
```

Or via Docker:

```bash
docker compose up -d trainer
```

### All-in-One (Root)

```bash
npm run dev          # concurrently runs backend + frontend
npm run build        # builds both for production
npm test             # runs backend + frontend tests
npm run docker:up    # docker compose up -d
npm run docker:down  # docker compose down
```

---

## Environment Variables

### Backend (`backend/.env`)

```env
# Server
PORT=3333
HOST=0.0.0.0
NODE_ENV=development
APP_KEY=syphon-dev-key-change-in-production-32ch
APP_NAME=syphon

# Database (MariaDB)
DB_CONNECTION=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307
MYSQL_USER=syphon
MYSQL_PASSWORD=syphon_pass
MYSQL_DB_NAME=syphon

# Redis
REDIS_CONNECTION=local
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=

# Meilisearch
MEILI_URL=http://localhost:7700
MEILI_KEY=syphon_meili_key

# Scraping
SCRAPE_INTERVAL_MINUTES=30
ANALYSIS_BATCH_SIZE=10

# Interactive Brokers TWS/Gateway
# TWS Paper: 7497, TWS Live: 7496, Gateway Paper: 4002, Gateway Live: 4001
IB_HOST=127.0.0.1
IB_PORT=7497
IB_CLIENT_ID=1

# Google Cloud (GDELT BigQuery news backfill)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
GCP_PROJECT_ID=your-project-id

# Kraken API (spot + margin + futures)
KRAKEN_API_KEY=
KRAKEN_API_SECRET=
KRAKEN_FUTURES_KEY=
KRAKEN_FUTURES_SECRET=

# Training API (optional, for NN integration)
TRAINING_API_URL=http://localhost:8000
```

---

## API Reference

Base URL: `http://localhost:3333/api`

### Dashboard & Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard` | Stats, queues, recent analyses, sentiment distribution, top tickers |
| POST | `/prune` | Wipe all data (articles, analyses, snapshots, decisions, queues) |
| GET | `/jobs/active` | Active/waiting/delayed BullMQ jobs |
| GET | `/jobs/failed` | Failed jobs (limit 50) |
| POST | `/jobs/:queue/:id/retry` | Retry a failed job |
| POST | `/jobs/:queue/:id/cancel` | Cancel a running job |
| DELETE | `/jobs/:queue/:id` | Remove a failed job |
| POST | `/jobs/drain` | Drain all queues |

### Articles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/articles` | Paginated list. Params: `page`, `limit`, `source`, `analyzed`, `sentiment` |
| GET | `/articles/search` | Full-text search. Params: `q`, `ticker`, `sentiment`, `source`, `date_from`, `date_to` |
| GET | `/articles/:id` | Single article with analyses |
| GET | `/articles/sources` | List scrape sources |
| POST | `/articles/scrape` | Trigger scrape. Body: `{ source_id }` |
| POST | `/articles/analyze` | Queue unanalyzed articles. Params: `limit` |
| POST | `/articles/backfill` | Backfill via GDELT BigQuery. Body: `{ symbol, days, fetch_content }` |

### Tickers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tickers` | List active tickers. Params: `limit`, `search`, `sector`, `exchange`, `sentiment`, `sort`, `dir` |
| GET | `/tickers/search` | Search tickers. Params: `q` |
| GET | `/tickers/:symbol` | Detail with quote, 90 snapshots, analyses, sentiment summary |
| POST | `/tickers` | Add ticker. Body: `{ symbol }` |
| POST | `/tickers/refresh-all` | Refresh all ticker prices (batches of 10) |
| POST | `/tickers/backfill` | Backfill historical OHLCV (Stooq CSV). Body: `{ symbol, days }` |
| POST | `/tickers/:symbol/refresh` | Refresh single ticker |
| DELETE | `/tickers/:symbol` | Deactivate ticker |

### Analysis

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/analysis` | Paginated list. Params: `page`, `limit`, `ticker`, `sentiment`, `sort`, `dir` |
| GET | `/analysis/:id` | Single analysis with article, ticker, snapshots |
| GET | `/analysis/stats` | Aggregate stats: overall, by ticker, recent |
| GET | `/analysis/timeline` | Sentiment timeline. Params: `ticker` (required), `days` |

### Quant Engine

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/quant/screener` | Batch screener. Params: `days`, `minArticles` |
| GET | `/quant/:symbol` | Full technical + sentiment + risk analysis for a symbol |

Screener response includes per ticker: composite score (0-100), signal (strong_buy/buy/hold/sell/strong_sell), conviction, regime, recommendation with stop-loss/take-profit/position size.

### Signals (Legacy)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/signals` | Delegates to QuantEngine. Params: `days`, `min_articles` |

### Algo Trading

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/algo/config` | Current algo configuration |
| PUT | `/algo/config` | Update config fields |
| POST | `/algo/enable` | Enable automated trading |
| POST | `/algo/disable` | Disable automated trading |
| POST | `/algo/run` | Trigger manual algo run |
| GET | `/algo/decisions` | Decision history. Params: `page`, `limit`, `run_id`, `symbol`, `decision` |
| GET | `/algo/positions` | Algo positions. Params: `status` (open/closing/closed/all) |
| POST | `/algo/positions/:id/close` | Force close a position |
| GET | `/algo/stats` | Performance: win rate, P&L, drawdown, avg hold, trades |

### Manual Trading

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/trading/status` | Broker connection status (IBKR + Kraken combined) |
| POST | `/trading/connect` | Connect. Body: `{ broker: 'ibkr' \| 'kraken' }` |
| POST | `/trading/disconnect` | Disconnect. Body: `{ broker }` |
| GET | `/trading/account` | Account balance & info. Params: `broker` |
| GET | `/trading/positions` | Current positions. Params: `broker` |
| GET | `/trading/stats` | P&L statistics. Params: `symbol` |
| GET | `/trading/orders` | Order history. Params: `page`, `limit`, `status`, `side`, `symbol` |
| GET | `/trading/orders/:id` | Single order detail |
| POST | `/trading/orders` | Place order. Body: `{ symbol, side, quantity, orderType, limitPrice?, stopPrice?, trailAmount?, broker? }` |
| POST | `/trading/orders/:id/cancel` | Cancel open order |

Supported order types: `MKT`, `LMT`, `STP`, `STP_LMT`, `TRAIL`

### Training (NN Proxy)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/training/health` | Service health + model loaded status |
| GET | `/training/config` | Hyperparameters, pairs, features |
| GET | `/training/model` | Model info: version, accuracy, Sharpe, architecture |
| POST | `/training/predict` | Single prediction. Body: `{ pair: "XXBTZUSD" }` |
| POST | `/training/predict/batch` | Batch predictions. Body: `{ pairs: [...] }` |
| POST | `/training/train` | Start training. Body: `{ pairs?, epochs?, batch_size?, learning_rate? }` |
| GET | `/training/train/status` | Training progress (fold, epoch, metrics) |
| POST | `/training/backfill` | Backfill Kraken OHLC. Body: `{ pairs?, days }` |
| GET | `/training/backfill/status` | Backfill progress |

### Metrics & Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/metrics` | System: memory, CPU, DB tables, Redis, Meilisearch, queues, service health |
| GET | `/logs` | Search logs. Params: `q`, `level`, `context`, `page`, `per_page` |
| GET | `/logs/stats` | Log level distribution |

### Notifications (SSE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/notifications/stream` | Server-Sent Events stream |

Event types: `connected`, `job_finished`, `job_progress`, `order_update`, `ticker_match`, `scrape_complete`

---

## Frontend

SvelteKit 5 SPA with dark-mode theme, Chart.js visualizations, real-time SSE updates, and a responsive layout across 11 pages.

### Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | System overview: stat cards (articles, tickers, analyses), sentiment distribution chart, queue status, top tickers, active/failed job management, action buttons (scrape, analyze, refresh, drain, prune) |
| `/articles` | Articles | Grid of article cards with source/sentiment filters, full-text search, pagination. Trigger scrapes and GDELT backfill |
| `/articles/[id]` | Article Detail | Full content, metadata, list of analyzed tickers with sentiment/relevance/confidence/reasoning |
| `/tickers` | Tickers | Watchlist: add/search/remove tickers, filter by sector/exchange/sentiment, sort, backfill history |
| `/tickers/[symbol]` | Ticker Detail | Price chart (Chart.js) with sentiment overlay, trade panel (OrderEntry), sentiment summary, recent analyses |
| `/analysis` | Analysis | All analyses: stat cards, by-ticker chips, filters (ticker/sentiment/sort), paginated table |
| `/quant` | Quant Screener | Full screener table: composite score, signal, conviction, regime, sentiment, RSI, MACD, trend, Sharpe, Beta, patterns. Click row for detail panel with score breakdown, recommendation, moving averages, oscillators, volatility, volume, risk |
| `/algo` | Algo Trading | Enable/disable toggle, config editor (13 parameters), positions table (open/closing/closed), performance stats (win rate, P&L, drawdown), decision log with filters |
| `/trading` | Manual Trading | Broker tabs (IBKR/Kraken), connection controls, account balances, quick trade (OrderEntry), positions, P&L by symbol, full order history with cancel |
| `/training` | Training | 3 tabs: Overview (model info, training/backfill status), Train & Backfill (start training/backfill), Predictions (single/batch with direction + confidence + returns) |
| `/metrics` | Metrics | Service health grid, process memory, Redis stats, system info, DB storage by table, queue totals + breakdown, Meilisearch indexes |
| `/logs` | Logs | Auto-refresh toggle, level/context stats, search/filter, color-coded log table |

### Shared Components

| Component | Purpose |
|-----------|---------|
| `StatCard` | Label + value + optional trend indicator (green/red) |
| `TickerChart` | Chart.js dual-axis: price line + sentiment overlay |
| `NewsTable` | Reusable table for analyses (ticker, article, sentiment, score, relevance, confidence) |
| `OrderEntry` | Trade form: side, order type, quantity, prices, broker options, estimated cost |
| `ArticleCard` | Article preview card with source, time, title, summary, ticker badges |
| `SentimentBadge` | Colored badge for sentiment labels |
| `NotificationToast` | SSE-driven toast notifications (top-right, auto-dismiss 8s) |

### Real-Time Updates

- **SSE streaming** (`/api/notifications/stream`): ticker matches, scrape completions, order updates, job progress/completion
- **Polling**: dashboard job polling (4s), metrics auto-refresh (15s)
- **Debounced search**: ticker search (300ms)

### Styling

Dark-mode CSS custom properties. Sentiment colors map to very_bullish (bright green) through very_bearish (bright red). Responsive grid layouts with card-based UI and hover effects.

---

## Backend Services

### ScraperService

Scrapes news from RSS feeds and HTML sources. Default sources include Google News, Yahoo Finance, CNBC, Reuters, and others. Parses articles with `rss-parser` (RSS) and `cheerio` (HTML). Deduplicates by external ID or URL. Saves to Meilisearch and auto-queues analysis.

### SentimentService

NLP sentiment engine using the `natural` library with AFINN lexicon enhanced by custom financial keywords (200+ terms). Supports multi-word phrases ("short squeeze", "bear market"), negation detection, and section weighting (title 3x, summary 2x). Returns: sentiment label (very_bearish to very_bullish), score (-1 to +1), confidence (0 to 1), and extracted keywords.

### TickerMatcherService

Matches articles against all active tickers by symbol and name. Computes relevance score based on match position, frequency, and context. Calls SentimentService for each match. Creates Analysis records in Meilisearch with full provenance.

### GoogleFinanceService

Fetches current quotes and company data from Google Finance. Syncs daily OHLCV snapshots via upsert (accumulated over time by cron). Price data normalized and stored in Meilisearch snapshots index.

### MeilisearchService

Wrapper around Meilisearch client. Manages 5 indexes (articles, analyses, snapshots, decisions, logs). Handles ID generation via Redis auto-increment. Provides search, filter, sort, and pagination across all indexes.

### QuantEngine

Unified scoring system combining technical analysis, sentiment, and risk metrics. See [QuantEngine section](#quantengine) below.

### AlgoTradingService

Automated trading decision engine. Loads config, checks broker connection, iterates tickers, applies entry/exit rules based on QuantEngine scores, manages positions. See [Algo Trading Engine section](#algo-trading-engine) below.

### IBKRService

Interactive Brokers TWS API client via `@stoqey/ib`. Manages socket connection to TWS/Gateway. Methods: connect, disconnect, getAccountSummary, getPositions, getOpenOrders, placeOrder, cancelOrder. Monitors order status via event callbacks.

### KrakenService

Kraken exchange REST API client. Supports spot, margin, and futures trading. HMAC-SHA512 authentication. Methods: connect (validate credentials), getBalance, getTradeBalance, getOpenPositions, getOpenOrders, placeOrder, cancelOrder, syncOrderStatus (polling).

### GDELTBigQueryService

Queries Google BigQuery for GDELT historical news articles. Filters by ticker symbol/name within date range. Used for backfilling article history for newly added tickers.

### NotificationService

In-memory event emitter. Broadcasts typed events (job_finished, job_progress, order_update, ticker_match, scrape_complete) to SSE-connected frontend clients with keep-alive pings.

---

## Background Jobs & Cron

### BullMQ Queues

Seven queues process async work. All jobs: 3 retry attempts with exponential backoff (5s initial), keep last 1000 completed and 5000 failed.

| Queue | Concurrency | Trigger | Description |
|-------|-------------|---------|-------------|
| `scrape-news` | 2 | Cron (every N min) | Scrapes RSS/HTML sources, deduplicates, saves to Meilisearch, auto-queues analysis |
| `analyze-article` | 5 | After scrape | Matches article to tickers, runs NLP sentiment, saves Analysis to Meilisearch |
| `fetch-ticker` | 1 | Cron (every 30 min) | Fetches Google Finance quotes, upserts daily OHLCV snapshots |
| `backfill-news` | 1 | Manual trigger | Queries GDELT BigQuery for historical news, bulk saves and queues analysis |
| `submit-order` | 2 | Algo/manual trade | Submits order to IBKR or Kraken, updates Trade status |
| `monitor-order` | 5 | After order submit | Polls broker until terminal status (max 720 attempts, ~1 hour) |
| `algo-trading` | 1 | Cron (:15, :45) | Runs QuantEngine screener, evaluates entries/exits, places trades |

### Cron Schedule

| Schedule | Job | Description |
|----------|-----|-------------|
| `*/N * * * *` | News scrape | Scrape all active sources (N = `SCRAPE_INTERVAL_MINUTES`, default 30) |
| `*/30 * * * *` | Ticker refresh | Batch refresh all active ticker prices |
| `15,45 * * * *` | Algo trading | Run automated decisions (offset from ticker refresh at :00/:30) |

### Boot Sequence

1. Meilisearch indexes created/verified
2. Default scrape sources ensured
3. BullMQ workers registered
4. Algo config ensured (singleton row)
5. Cron jobs scheduled
6. Log forwarder attached (pino -> Meilisearch)

---

## Data Flow

```
1. SCRAPE     Cron triggers RSS/HTML scrape -> articles saved to Meilisearch
                                               |
2. ANALYZE    TickerMatcherService matches articles to tickers ->
              SentimentService scores each match -> analyses saved to Meilisearch
                                               |
3. REFRESH    Cron triggers Google Finance fetch -> current price in MariaDB
              + daily OHLCV snapshot upsert in Meilisearch
                                               |
4. QUANT      QuantEngine loads snapshots + sentiment ->
              composite score (technical 65%, sentiment 20%, risk 15%)
                                               |
5. ALGO       AlgoTradingService runs screener -> filters by score/conviction/regime ->
              places orders via IBKR or Kraken -> monitors fills -> reconciles positions
                                               |
6. OPTIONAL   NN prediction (40% weight) blended with QuantEngine score (60% weight)
              when training API is available
```

---

## Data Storage

### Meilisearch Indexes

| Index | Primary Key | Filterable | Sortable | Max Hits |
|-------|-------------|------------|----------|----------|
| `articles` | `id` (Redis auto-incr) | tickers, sentiment, sourceName, publishedAt, isAnalyzed, externalId, url, scrapeSourceId, createdAt | publishedAt, createdAt, sentimentScore | 50,000 |
| `analyses` | `{articleId}_{tickerId}` | articleId, tickerId, tickerSymbol, sentiment, sentimentScore, createdAt | createdAt, sentimentScore, relevanceScore, confidence | 50,000 |
| `snapshots` | `{tickerId}_{date}` | tickerId, tickerSymbol, date | date, createdAt | 100,000 |
| `decisions` | `id` (Redis auto-incr) | runId, symbol, decision, tickerId, createdAt | createdAt, compositeScore | 50,000 |
| `logs` | `{timestamp}-{counter}` | level, context, timestamp | timestamp | default |

### MariaDB Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `tickers` | Tracked symbols | symbol (unique), name, exchange, sector, current_price, market_cap, is_active |
| `ticker_snapshots` | Daily OHLCV (unique ticker_id+date) | open, high, low, close, volume, change_percent, date |
| `scrape_sources` | News source config | name, slug, type (rss/html/api), url, config JSON, is_active |
| `articles` | Article records | title, summary, content, url, source_name, published_at, is_analyzed |
| `analyses` | Sentiment results (unique article_id+ticker_id) | sentiment, sentiment_score, relevance_score, confidence, keywords JSON, reasoning |
| `trades` | Order records | symbol, side, order_type, quantity, fill_price, status, broker (ibkr/kraken), commission, realized_pnl |
| `algo_configs` | Algo parameters (singleton) | enabled, dry_run, broker, entry/exit thresholds, position limits, allowed_regimes JSON |
| `algo_decisions` | Trade decisions | run_id, symbol, decision (enter/exit/hold/skip), composite_score, conviction, regime, context JSON |
| `algo_positions` | Tracked positions | symbol, side, quantity, entry/exit price, stop_loss, take_profit, status (open/closing/closed), realized_pnl |

---

## QuantEngine

Unified scoring system in `backend/app/Services/QuantEngine.ts`.

### Composite Score (0-100)

#### Technical (65%)

| Factor | Weight | Description |
|--------|--------|-------------|
| RSI | 10% | Oversold/overbought levels (RSI-14) |
| MACD | 10% | Histogram direction, signal crossovers, bullish/bearish divergence |
| Bollinger Bands | 7% | %B position, squeeze detection |
| Trend | 10% | SMA 20/50/200 alignment, golden/death cross |
| ADX | 7% | Trend strength |
| Stochastic | 5% | %K/%D crossovers, oversold/overbought |
| Momentum | 8% | 20-day return magnitude |
| Volume | 4% | Volume ratio vs 20-day SMA |
| Patterns | 4% | Candlestick and chart patterns |

#### Sentiment (20%)

| Factor | Weight | Description |
|--------|--------|-------------|
| Score | 12% | Weighted average sentiment from analyses |
| Momentum | 5% | Recent vs older sentiment trend |
| News Volume | 3% | Article coverage intensity |

#### Risk/Fundamentals (15%)

| Factor | Weight | Description |
|--------|--------|-------------|
| Sharpe Ratio | 4% | Risk-adjusted return |
| Beta | 3% | Market correlation |
| P/E Ratio | 4% | Valuation |
| 52-Week Position | 4% | Price range context |

### Additional Outputs

- **Signal**: strong_buy / buy / hold / sell / strong_sell (based on composite score thresholds)
- **Regime Detection**: trending_up, trending_down, ranging, volatile (based on ADX, trend, volatility)
- **Conviction Score**: 0-1, measures agreement across scoring categories
- **Recommendation**: BUY/SELL/HOLD with position size %, stop-loss, take-profit, risk/reward ratio
- **Pattern Detection**: double top/bottom, head & shoulders, breakouts, divergences, engulfing, doji, hammer

### Screener Optimization

The batch screener preloads all snapshots and analyses in a single query to avoid N+1 problems when analyzing all active tickers.

---

## Algo Trading Engine

`backend/app/Services/AlgoTradingService.ts`

### Decision Loop

Each algo run (triggered by cron at :15 and :45, or manually):

1. Load algo config from MariaDB
2. Verify broker connection (IBKR or Kraken)
3. Fetch portfolio value from broker
4. Run QuantEngine screener across all active tickers
5. For each ticker, evaluate:
   - **Entry**: score >= threshold, conviction >= min, regime in allowed list, articles >= min, not already positioned, not on cooldown, position limits not exceeded
   - **Exit**: existing position where score <= exit threshold OR holding days exceeded OR force-close flagged
   - **Hold/Skip**: reasons logged
6. Place orders via submit-order queue
7. Record AlgoDecision for every ticker evaluated
8. Reconcile algo positions (update current prices, check stop-loss/take-profit)

### Configuration Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `enabled` | boolean | Master switch |
| `dry_run` | boolean | Log decisions without placing orders |
| `broker` | ibkr / kraken | Target broker |
| `entry_score_threshold` | 1-100 | Min composite score to enter |
| `min_conviction` | 0-1 | Min conviction score |
| `min_articles` | 0-50 | Min articles analyzed for ticker |
| `exit_score_threshold` | -100 to 0 | Score below which to exit |
| `max_positions` | 1-50 | Max concurrent positions |
| `max_exposure_pct` | 0.1-1 | Max portfolio % in positions |
| `max_single_position_pct` | 0.01-0.5 | Max portfolio % per position |
| `daily_loss_limit_pct` | 0.01-0.2 | Stop trading after this daily loss |
| `max_holding_days` | 1-365 | Force exit after N days |
| `order_type` | MKT / LMT | Order type for entries/exits |
| `time_in_force` | DAY / GTC | Order duration |
| `cooldown_minutes` | 1-60 | Wait between decisions on same ticker |
| `allowed_regimes` | array | Regime whitelist (trending_up, trending_down, ranging, volatile) |
| `excluded_symbols` | array | Blacklisted symbols |

---

## Neural Network (Training Service)

A PyTorch Transformer model for intraday crypto price prediction, served via FastAPI.

### Architecture: TradingTransformer

```
Input (120 bars x 40 features)
    |
Linear Projection (40 -> 128) + LayerNorm + GELU
    |
Learnable Positional Encoding (120 positions x 128 dim)
    |
TransformerEncoder (4 layers, 8 heads, d_model=128, FFN=256, pre-norm, GELU)
    |
Attention Pooling (sequence -> single vector)
    |
Shared MLP (128 -> 64) + GELU + Dropout
    |
+---------------------+------------------------+---------------------+
| Direction Head       | Return Head            | Confidence Head     |
| Linear(64 -> 3)     | Linear(64 -> 3)        | Linear(64 -> 1)     |
| {down, flat, up}    | {30m, 1h, 3h returns}  | Sigmoid [0,1]       |
| CrossEntropy loss    | Huber loss (d=0.01)    | BCE loss            |
+---------------------+------------------------+---------------------+
```

### Feature Engineering (40 features per bar)

| Category | Count | Features |
|----------|-------|----------|
| Price | 5 | Close/open/high/low pct returns, spread |
| Volume | 4 | Log volume, normalized VWAP, trade count, volume MA ratio |
| Technical | 12 | RSI(14,7), MACD hist, Stochastic K/D, Bollinger %B/width, ATR-14, ADX, +DI/-DI |
| Moving Averages | 4 | Price/EMA(9,21) ratios, price/SMA(50) ratio, EMA cross |
| Momentum | 4 | Returns at 30min, 1hr, 3hr, 6hr |
| Volatility | 4 | Realized vol (1h, 3h), Parkinson vol, Garman-Klass vol |
| Microstructure | 3 | VWAP deviation, volume imbalance, candle body ratio |
| Temporal | 4 | Hour sin/cos, weekday sin/cos (cyclical encoding) |

### Training Pipeline

- **Walk-Forward Validation**: 30-day training window, 7-day validation window, sliding forward
- **Optimizer**: AdamW (lr=1e-4, weight_decay=1e-5)
- **Scheduler**: OneCycleLR
- **Mixed Precision**: AMP with GradScaler on GPU
- **Gradient Clipping**: max norm 1.0
- **Early Stopping**: patience 10, monitored metric = direction_accuracy * max(Sharpe, 0.01)
- **Class Weighting**: automatic balancing for direction labels
- **Loss Weights**: direction 1.0, return_30m 0.5, return_1h 1.0, return_3h 1.5 (primary), confidence 0.3

### Direction Classification

Target labels based on 3-hour forward return:
- **Down**: return < -0.3%
- **Flat**: -0.3% <= return <= +0.3%
- **Up**: return > +0.3%

### Evaluation Metrics

- Direction accuracy (overall and per-class)
- Profitable direction accuracy (weighted by return magnitude)
- Return MAE and Pearson correlation at each horizon
- Simulated Sharpe ratio (long up, short down, flat neutral)
- Win rate, max drawdown, strategy return
- Confidence calibration correlation

### Data Sources

- **Price data**: Kraken public OHLC API (5-minute bars), stored as Parquet
- **Sentiment data**: MariaDB analyses table (joined via crypto symbol mapping)
- **Default pairs**: XXBTZUSD (BTC), XETHZUSD (ETH), SOLUSD, XRPUSD, ADAUSD

### Integration with Backend

When the training API is available, QuantEngine blends NN predictions (40% weight) with its own composite score (60% weight) for crypto tickers.

### CLI Scripts

```bash
# Backfill historical data from Kraken
python scripts/backfill.py --pair XXBTZUSD --days 90

# Train model with walk-forward validation
python scripts/train.py --config config.yaml --epochs 50

# Backtest on recent data
python scripts/backtest.py --model checkpoints/best_model.pt --days 30
```

### FastAPI Endpoints (Direct)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Status + model loaded + device |
| GET | `/config` | Full config.yaml contents |
| GET | `/model/info` | Model version, trained_at, architecture, val_metrics |
| POST | `/predict` | Single pair prediction: direction, probs, returns, confidence |
| POST | `/predict/batch` | Multiple pairs: predictions + errors |
| POST | `/train` | Start training (async background) |
| GET | `/train/status` | Progress: running, fold, epoch, metrics, summary |
| POST | `/backfill` | Start Kraken OHLC backfill (async background) |
| GET | `/backfill/status` | Progress: current pair, pairs done, bars fetched |

---

## Seeded Tickers

The default seeder populates 122 tickers across 14 categories:

| Category | Count | Examples |
|----------|-------|---------|
| Magnificent 7 | 7 | AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA |
| Big Tech & Semis | 22 | AMD, INTC, AVGO, CRM, PLTR, COIN, CRWD |
| Finance & Banking | 12 | JPM, GS, BAC, V, MA, PYPL |
| Healthcare & Pharma | 12 | JNJ, UNH, LLY, MRNA, PFE |
| Consumer & Retail | 11 | WMT, COST, HD, NKE, MCD |
| Media & Entertainment | 7 | DIS, NFLX, SPOT, RBLX |
| Industrial & Defense | 10 | BA, LMT, CAT, GE |
| Energy | 6 | XOM, CVX, COP |
| Automotive & EV | 7 | F, TSLA, RIVN, NIO |
| Telecom | 3 | T, VZ, TMUS |
| Real Estate | 4 | AMT, PLD, SPG, O |
| ETFs | 13 | SPY, QQQ, DIA, IWM, GLD, TLT |
| Crypto-related | 3 | IBIT, MARA, RIOT |
| Chinese ADRs | 4 | BABA, JD, PDD, BIDU |

---

## Development

### Root Scripts

```bash
npm run dev              # Backend + frontend concurrently
npm run dev:backend      # Backend only (node ace serve --watch)
npm run dev:frontend     # Frontend only (Vite dev server)
npm run build            # Build both
npm test                 # Test both
```

### Backend Commands

```bash
node ace serve --watch         # Dev server with hot reload (port 3333)
node ace queue:listen          # Start BullMQ workers
node ace migration:run         # Run pending migrations
node ace migration:rollback    # Rollback last batch
node ace db:seed               # Seed default tickers
npm test                       # Run all tests (294 passing)
npm run test:unit              # Unit tests only
npm run test:functional        # Functional tests only
```

### Frontend Commands

```bash
npm run dev             # Vite dev server (port 5173, proxies /api to :3333)
npm run build           # Production build
npm run preview         # Preview production build
npm run test            # Vitest
npm run test:watch      # Vitest watch mode
```

### Docker Commands

```bash
docker compose up -d                            # Start all services
docker compose up -d mariadb redis meilisearch  # Infrastructure only
docker compose logs -f meilisearch              # Tail service logs
docker compose ps                               # Check health status
docker compose down                             # Stop all
docker compose down -v                          # Stop + remove volumes
```

### Key Notes

- Backend deps require `--legacy-peer-deps` due to AdonisJS 5 peer conflicts
- `@adonisjs/cors@2.1.0` is pinned (2.2.1+ requires AdonisJS 6)
- Frontend uses `type: "module"` in package.json
- No svelte-chartjs (incompatible with Svelte 5) -- Chart.js used directly
- Vite dev server proxies `/api` requests to `http://localhost:3333`

---

## Deployment

### Resource-Constrained Environments (Raspberry Pi)

The infrastructure is optimized for low memory:

- **MariaDB**: tuned buffer pool (128M), max 30 connections, reduced log/cache sizes
- **Redis**: 64MB memory limit, `noeviction` policy
- **Meilisearch**: 128MB limit (replaces OpenSearch, ~10x lighter)
- **Total infrastructure memory**: ~736MB (without trainer)

All Docker services have `deploy.resources.limits.memory` set and health checks configured.

The training service is intended to run on a separate machine with more resources (GPU preferred) -- not on the Pi.

### Port Summary

| Service | Port |
|---------|------|
| Backend API | 3333 |
| Frontend dev | 5173 |
| MariaDB | 3307 (maps to internal 3306) |
| Redis | 6379 |
| Meilisearch | 7700 |
| Training API | 8000 |
