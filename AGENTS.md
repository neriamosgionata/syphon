<!-- AdonisJS backend (syphon) -->
# Adonis Backend Instructions

## Environment quirks
- **`NODE_OPTIONS` is broken**: shell exports `NODE_OPTIONS=--import=file://.../headroom/.../hook-shim/handler.js` pointing at a missing file. Every `node`/`npx` invocation fails with `ERR_MODULE_NOT_FOUND` on that shim. Always run `unset NODE_OPTIONS` first (or prefix: `unset NODE_OPTIONS && node ...`).
- **Do NOT typecheck with plain `tsc`**: Adonis IOC aliases (`App/*`, `@ioc:*`) only resolve through the Adonis assembler. Plain `tsc --noEmit` floods with TS2307 noise. Use `node ace build --production` (compiles to `backend/build/`) — it fails on real type errors. (Note: in this repo the workspace-hoisted deps break `adonis-preset-ts`'s relative `baseUrl`, so `ace build` also floods TS2307; app still boots and runs fine via the runtime IOC.)
- **Tests**: `cd backend && npm test` = `node -r @adonisjs/assembler/build/register tests/bootstrap.ts`. Requires: MariaDB (3307), Redis (6379), Meilisearch (7700) running + `backend/.env` (copy `.env.example`; none exists — create from `docker-compose.yml` creds + README).
- **Infra**: Redis is a docker container on 6379 (native `redis-server.service` is disabled — the container can't bind while it's running). MariaDB + Meili via `docker compose up -d mariadb redis meilisearch` (podman, rootless).
- `npm install` requires `--legacy-peer-deps`.

## Adonis/MariaDB conventions
- Migrations: numbered files `backend/database/migrations/N_name.ts` (1-12 used). New migration must be `13_...`+.
- **ENUM columns cannot be altered with `table.enum()`** in MariaDB — use `this.schema.raw("ALTER TABLE ... MODIFY col ENUM(...) NOT NULL DEFAULT '...'")`.
- DECIMAL columns return **strings** from mysql2 — coerce with `Number()` before math.
- `trades.quantity`, `trades.filled_quantity`, `algo_positions.quantity` are DECIMAL(18,8) — crypto fractional quantities are valid; never `Math.floor` fills.
- Broker paths: IBKR (`@stoqey/ib`, socket-driven status), Kraken/Binance (REST, `syncOrderStatus` polling), FastTradeEngine (Binance WS + 100ms batched DB flush).

## Meilisearch quirks
- Modern Meilisearch (≥1.13) has **no create-index route** (POST/PUT `/indexes` → 405). Indexes are created implicitly by a settings PATCH; set the primary key via `PATCH /indexes/:uid` `{"primaryKey":"id"}` afterwards — otherwise documents with several `*Id` fields fail primary-key inference and every write is silently rejected. `MeilisearchService.ensureIndex()` handles this; keep it that way.
- Search `limit` caps at the index `pagination.maxTotalHits` setting — batch fetches must stay under it.

## Workflow
- After editing backend code: run `unset NODE_OPTIONS && cd backend && npm test` (or `npm run test:unit` / `npm run test:functional`).
- After editing frontend: `cd frontend && npm test`.
