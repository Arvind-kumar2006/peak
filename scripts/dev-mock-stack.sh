#!/usr/bin/env bash
# Start PEAK's full mock stack (no API keys, no Postgres, no Render):
#   3 MCP servers in MOCK=1, report-mcp, the scripted mock model, then TrueForge + setup.
# Ctrl+C stops everything. Pass MOCK_BEHAVIOR=trap to make the mock model pick wrong fixes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MOCK=1 MODEL_PROVIDERS=mock

for dir in mcp/_shared mcp/db mcp/cloud mcp/github agent; do
  [ -d "$ROOT/$dir/node_modules" ] || (cd "$ROOT/$dir" && npm install --no-audit --no-fund --silent)
done

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

start() { local name=$1; shift; ("$@" 2>&1 | sed "s/^/[$name] /") & pids+=($!); }
start db-mcp     node "$ROOT/mcp/db/server.js"
start cloud-mcp  node "$ROOT/mcp/cloud/server.js"
start github-mcp node "$ROOT/mcp/github/server.js"
start report-mcp node "$ROOT/agent/report-mcp/server.mjs"
start mock-model node "$ROOT/agent/mock-model.mjs"
start model-proxy node "$ROOT/agent/model-proxy.mjs"   # Groq compatibility (real-model runs)
start trueforge  "$ROOT/scripts/start-trueforge.sh"

echo "waiting for TrueForge on :8790 ..."
until curl -sf localhost:8790/api/v1/capabilities >/dev/null; do sleep 1; done
(cd "$ROOT/agent" && node setup.mjs)

cat <<MSG

✓ Mock stack running.
  Dashboard:         cd backend && TRUEFORGE_MODE=real MODEL_PROVIDERS=mock MOCK_WORLD_URL=http://localhost:7101 npm start
                     cd dashboard && npm run dev   → http://localhost:5173
  Run an incident:   cd agent && MODEL_PROVIDERS=mock node run-incident.mjs --scenario A   (or B, --decision deny)
  Switch scenario:   curl -X POST localhost:7101/mock/state -d '{"scenario":"B"}'
  TrueForge UI:      http://localhost:8790
Ctrl+C to stop.
MSG
wait
