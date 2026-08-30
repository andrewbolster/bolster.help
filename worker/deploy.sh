#!/usr/bin/env bash
#
# Deploy the Worker.
#
# `wrangler deploy` cannot be used: it reads
# /accounts/{id}/workers/subdomain before every deploy, and the API token in
# use cannot see that endpoint — the failure surfaces as a bare "Authentication
# error [code: 10000]" that looks like a bad token rather than a missing scope.
# Uploading the script directly is one multipart PUT and avoids the whole
# question.
#
# Usage:
#   set -a; . ~/.cf-token; set +a
#   ./worker/deploy.sh
#
# Requires CLOUDFLARE_API_TOKEN with Account > Workers Scripts > Edit.
# ALLOWED_ORIGINS may be overridden; everything else is fixed by wrangler.toml.
#
# MIGRATE=1 creates the Durable Object class, and may be used ONCE. Replaying
# it fails with 10074 because existing objects already depend on the class.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN — see ~/.cf-token}"

ACCOUNT=1a929e6f9bfe075e1a8dd9f9003497d1
SCRIPT=bolster-help
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/src" && pwd)"

KV_ID=7683a8d90ea6451bace7e2458cd8fe17
D1_ID=81abb174-fba4-4181-9e6f-adef56df939f

# Kept in step with wrangler.toml by hand. tests/unit/config.test.mjs asserts
# the two agree on the model and the Durable Object class.
: "${ALLOWED_ORIGINS:=https://bolster.help,https://www.bolster.help,https://andrewbolster.info,https://andrewbolster.github.io,https://bolster-help-5le.pages.dev,http://localhost:5173}"

if [ "${MIGRATE:-0}" = "1" ]; then
  migrations='"migrations": { "new_sqlite_classes": ["NeuronBudget"] },'
else
  migrations=''
fi

metadata=$(cat <<JSON
{
  "main_module": "index.js",
  "compatibility_date": "2026-05-01",
  $migrations
  "bindings": [
    { "type": "ai", "name": "AI" },
    { "type": "durable_object_namespace", "name": "NEURON_BUDGET", "class_name": "NeuronBudget" },
    { "type": "kv_namespace", "name": "SESSIONS", "namespace_id": "$KV_ID" },
    { "type": "d1", "name": "DB", "id": "$D1_ID" },
    { "type": "ratelimit", "name": "MCP_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
    { "type": "ratelimit", "name": "LLM_RATE_LIMIT", "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } },
    { "type": "plain_text", "name": "MCP_ORIGIN", "text": "https://mcp.bolster.online/mcp" },
    { "type": "plain_text", "name": "ALLOWED_ORIGINS", "text": "$ALLOWED_ORIGINS" },
    { "type": "plain_text", "name": "GITHUB_ALLOWED_LOGINS", "text": "andrewbolster" },
    { "type": "plain_text", "name": "WORKERS_AI_MODEL", "text": "@cf/ibm-granite/granite-4.0-h-micro" }
  ]
}
JSON
)

args=(-sS -X PUT
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$SCRIPT"
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  -F "metadata=$metadata;type=application/json")

for module in index.js allowlist.js auth.js budget.js chats.js llm.js workers-ai.js; do
  args+=(-F "$module=@$SRC/$module;type=application/javascript+module;filename=$module")
done

curl "${args[@]}" | python3 -c '
import json, sys
result = json.load(sys.stdin)
if result.get("success"):
    print("deployed:", result["result"]["id"], result["result"]["modified_on"])
else:
    print("FAILED:", result.get("errors"))
    sys.exit(1)
'
