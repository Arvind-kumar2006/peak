#!/usr/bin/env bash
# Start the whole PEAK stack with one command:
#   demo app (if demo-app/.env has DATABASE_URL) · 3 MCP servers · report-mcp · Groq proxy ·
#   mock model · TrueForge (+ setup) · backend · dashboard
#
#   ./scripts/start-all.sh            real model from .env (Groq → Gemini → OpenAI → xAI)
#   ./scripts/start-all.sh --mock     scripted mock model, no API keys needed
#   ./scripts/start-all.sh --no-db    skip the demo app even if a database is configured
#
# Logs: logs/<service>.log   ·   Ctrl+C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

USE_MOCK=0
USE_DB=1
for arg in "$@"; do
  case "$arg" in
    --mock) USE_MOCK=1 ;;
    --no-db) USE_DB=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- preflight ----------
say "Preflight"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "Node.js >= 22.14 required (found $(node -v))"
[ -f "$ROOT/.env" ] || die "No .env at the repo root — copy .env.example to .env and fill in a model key (or use --mock)"
[ -f "$ROOT/backend/.env" ] || warn "No backend/.env — the backend will use its defaults (fake agent unless TRUEFORGE_MODE=real)"

# Root .env → environment for everything started below.
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a
export MOCK="${MOCK:-1}"
export TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
if [ "$USE_MOCK" = 1 ]; then
  export MODEL_PROVIDERS=mock
  ok "model: scripted mock (no API calls)"
else
  ok "model providers: ${MODEL_PROVIDERS:-groq,gemini,openai,xai}"
fi

busy=""
for port in 3000 4000 5173 7101 7102 7103 7104 7300 7310 8790; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then busy="$busy $port"; fi
done
[ -z "$busy" ] || die "Ports already in use:$busy — stop the other PEAK processes first (e.g. an earlier run of this script)"
ok "ports free"

say "Installing dependencies (first run only)"
for dir in mcp/_shared mcp/db mcp/cloud mcp/github agent backend dashboard demo-app; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    (cd "$ROOT/$dir" && npm install --no-audit --no-fund --silent) && ok "$dir"
  fi
done
ok "dependencies ready"

# ---------- process management ----------
pids=()
cleanup() {
  trap - EXIT INT TERM
  echo
  say "Stopping everything"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  # npx (TrueForge, vite) spawns children that can outlive their parent — free the ports too.
  for port in 3000 4000 5173 7101 7102 7103 7104 7300 7310 8790; do
    for pid in $(ss -ltnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | sort -u); do kill "$pid" 2>/dev/null || true; done
  done
  wait 2>/dev/null || true
  ok "stopped"
}
trap cleanup EXIT INT TERM

# start <name> <dir> <command...> — runs in <dir>, output to logs/<name>.log
start() {
  local name=$1 dir=$2; shift 2
  (cd "$ROOT/$dir" && exec "$@") >"$LOGS/$name.log" 2>&1 &
  pids+=($!)
}

# wait_for <name> <url> [seconds]
wait_for() {
  local name=$1 url=$2 limit=${3:-60} i=0
  until curl -sf -o /dev/null "$url"; do
    i=$((i + 1))
    if [ "$i" -ge "$limit" ]; then die "$name did not come up — see logs/$name.log"; fi
    sleep 1
  done
  ok "$name  $url"
}

# wait_port <name> <port> — for servers with no plain GET endpoint (MCP)
wait_port() {
  local name=$1 port=$2 i=0
  until ss -ltn 2>/dev/null | grep -q ":$port "; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then die "$name did not come up — see logs/$name.log"; fi
    sleep 1
  done
  ok "$name  :$port"
}

# ---------- demo app (P1) ----------
say "Demo app"
if [ "$USE_DB" = 1 ] && [ -f "$ROOT/demo-app/.env" ] && grep -q '^DATABASE_URL=.\+' "$ROOT/demo-app/.env"; then
  (cd "$ROOT/demo-app" && node --env-file-if-exists=.env --network-family-autoselection-attempt-timeout=3000 scripts/db-setup.mjs) >"$LOGS/db-setup.log" 2>&1 \
    || die "database setup failed — see logs/db-setup.log"
  ok "database schema + seed (fresh demo state)"
  start demo-app demo-app node --env-file-if-exists=.env --network-family-autoselection-attempt-timeout=3000 --expose-gc src/index.js
  wait_for demo-app http://localhost:3000/health 30
else
  warn "skipped (no DATABASE_URL in demo-app/.env, or --no-db) — the dashboard uses the MCP mock world"
fi

# ---------- agent side (P2 + P3) ----------
say "MCP servers, report-mcp, model proxy, mock model"
start db-mcp     mcp/db     node server.js
start cloud-mcp  mcp/cloud  node server.js
start github-mcp mcp/github node server.js
start report-mcp agent      node report-mcp/server.mjs
start model-proxy agent     node model-proxy.mjs
start mock-model agent      node mock-model.mjs
for s in "db-mcp 7101" "cloud-mcp 7102" "github-mcp 7103" "report-mcp 7104" "model-proxy 7310" "mock-model 7300"; do
  wait_port $s
done
[ "$MOCK" = 1 ] && ok "MCP servers in MOCK mode: agent, Simulate and the chart all use the simulated world (MOCK=0 in .env once P2's real mode is ready)"

say "TrueForge"
start trueforge . "$ROOT/scripts/start-trueforge.sh"
wait_for trueforge http://localhost:8790/api/v1/capabilities 120
(cd "$ROOT/agent" && node setup.mjs) >"$LOGS/setup.log" 2>&1 || die "TrueForge setup failed — see logs/setup.log"
ok "providers, MCP servers and the incident-investigator agent registered"

# ---------- backend + dashboard (P4) ----------
say "Backend and dashboard"
# MOCK=1 → the agent's tools read the mock world, so the backend must drive and chart it too.
if [ "$MOCK" = 1 ]; then world=http://localhost:7101; else world=; fi
backend_env=(MODEL_PROVIDERS="$MODEL_PROVIDERS" TRUEFORGE_MODE=real MOCK_WORLD_URL="$world" DEMO_APP_URL="${DEMO_APP_URL:-http://localhost:3000}" ADMIN_TOKEN="${ADMIN_TOKEN:-change-me}")
start backend backend env "${backend_env[@]}" node src/index.js
wait_for backend http://localhost:4000/api/health 30
start dashboard dashboard npx vite --port 5173 --strictPort
wait_for dashboard http://localhost:5173 60

cat <<MSG

$(printf '\033[1;32m✓ PEAK is running\033[0m')

  Dashboard      http://localhost:5173
  TrueForge UI   http://localhost:8790
  Backend API    http://localhost:4000/api/health
  Logs           $LOGS/<service>.log   (e.g. tail -f logs/backend.log)

  Model: ${MODEL_PROVIDERS}$( [ "$MODEL_PROVIDERS" != mock ] && [ -n "${GROQ_API_KEY:-}" ] && printf '  (Groq free tier ≈ 3–4 min per incident)')

Press Ctrl+C to stop everything.
MSG

# Stay up until Ctrl+C, and stop everything if any service dies.
while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "a service exited — check logs/ (stopping the stack)"
      exit 1
    fi
  done
  sleep 3
done
