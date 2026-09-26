#!/usr/bin/env bash
# Start TrueForge pinned to the version we verified, allowing local MCP servers.
set -euo pipefail

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "TrueForge needs Node.js >= 22.14 (found $(node -v))" >&2
  exit 1
fi

export OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'
exec npx -y @truefoundry/trueforge@0.2.1 --port "${TRUEFORGE_PORT:-8790}"
