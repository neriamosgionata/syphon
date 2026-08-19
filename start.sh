#!/usr/bin/env bash
#
# Syphon full-system startup: docker infra + backend + BullMQ workers + frontend.
#
# Usage:
#   ./start.sh                 dev mode (hot reload)
#   ./start.sh --prod          build + run production servers
#   ./start.sh --trainer       also start the PyTorch trainer container
#   ./start.sh --no-infra      skip docker compose (infra already running)
#   ./start.sh --help
#
# Ctrl-C stops everything (containers keep running; stop with: docker compose down).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MODE="dev"
WITH_TRAINER=0
WITH_INFRA=1
PIDS=()

log()  { printf '\033[1;34m[start]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[start]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[start]\033[0m %s\n' "$*" >&2; exit 1; }

# Headroom's opencode plugin injects NODE_OPTIONS (--import hook-shim).
# Fixed globally (shim restored + ~/.config/node-options-guard.sh); the
# unset below is harmless insurance for shells running outside that guard.
unset NODE_OPTIONS

for arg in "$@"; do
  case "$arg" in
    --prod)      MODE="prod" ;;
    --trainer)   WITH_TRAINER=1 ;;
    --no-infra)  WITH_INFRA=0 ;;
    --help|-h)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1 \
  || die "docker/podman not found"
command -v node >/dev/null 2>&1 || die "node not found"

# ---------------------------------------------------------------------------
# 1. Infrastructure (docker compose)
# ---------------------------------------------------------------------------
if [ "$WITH_INFRA" = "1" ]; then
  log "starting docker infrastructure (redis, meilisearch)"
  SERVICES="redis meilisearch"
  [ "$WITH_TRAINER" = "1" ] && SERVICES="$SERVICES trainer"
  docker compose up -d $SERVICES

  log "waiting for infrastructure health..."
  wait_for_health() {
    local svc=$1 cmd=$2 tries=0
    until docker compose exec -T "$svc" sh -lc "$cmd" >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -ge 60 ] && die "timed out waiting for $svc"
      sleep 2
    done
    log "$svc healthy"
  }
  wait_for_health redis     'redis-cli ping | grep -q PONG'
  wait_for_health meilisearch 'curl -sf http://localhost:7700/health >/dev/null'
  [ "$WITH_TRAINER" = "1" ] && \
    wait_for_health trainer 'curl -sf http://localhost:8000/health >/dev/null'
else
  log "skipping docker infrastructure (--no-infra)"
fi

# ---------------------------------------------------------------------------
# 2. Backend prerequisites
# ---------------------------------------------------------------------------
[ -f backend/.env ] || die "backend/.env missing (needed for Redis/Meili credentials)"
[ -f backend/ace.js ] || die "backend/ace.js missing"

if [ ! -d node_modules ]; then
  log "installing dependencies (npm install --legacy-peer-deps)"
  npm install --legacy-peer-deps
fi

if [ "$MODE" = "prod" ]; then
  log "building backend + frontend"
  npm run build
fi

log "running database migrations"
(cd backend && node ace migration:run)

log "seeding default tickers (idempotent)"
(cd backend && node ace db:seed)

# ---------------------------------------------------------------------------
# 3. Launch processes
# ---------------------------------------------------------------------------
launch() {
  local name=$1; shift
  log "starting $name: $*"
  ( cd "$ROOT" && exec "$@" ) 2>&1 | sed -u "s/^/[$name] /" &
  PIDS+=("$!")
}

if [ "$MODE" = "prod" ]; then
  launch backend  sh -c 'cd backend/build && exec node server.js'
  launch frontend npm --prefix frontend run preview -- --host
else
  launch backend  node backend/ace.js serve --watch
  launch frontend npm --prefix frontend run dev
fi
# BullMQ workers run in-process (backend/start/jobs.ts registers all 7).
# The legacy `ace queue:listen` command is broken (IocLookupException) and
# would double-register workers anyway.

cleanup() {
  log "stopping processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

log "all services launched."
log "  backend API : http://localhost:3333  (BullMQ workers in-process)"
log "  frontend    : http://localhost:5173"
log "  redis       : localhost:6379   meilisearch: localhost:7700"
[ "$WITH_TRAINER" = "1" ] && log "  trainer     : http://localhost:8000"
log "press Ctrl-C to stop."

# Wait on children; if any exits, take everything down.
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "a process exited unexpectedly — stopping the rest"
      cleanup
    fi
  done
  sleep 2
done
