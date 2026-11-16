#!/usr/bin/env bash
#
# 9router-fix.sh — point an existing 9Router provider at the bridge.
#
# Why this is needed: 9Router resolves an openai-compatible provider's upstream
# URL from providerConnections.data.providerSpecificData.baseUrl, and its
# executor builds headers only from the static registry or runtimeTransport —
# providerSpecificData headers are never read. So the only way to fix the UA
# gate without patching 9Router itself is to swap its baseUrl for the bridge.
#
# Usage:
#   ./scripts/9router-fix.sh <provider-id | connection-id | node-id> [bridge-url]
#   ./scripts/9router-fix.sh list
#
# Examples:
#   ./scripts/9router-fix.sh list
#   ./scripts/9router-fix.sh openai-compatible-chat-5ddf6535-f293-47e9-8e90-679a6b06ff76
#   ./scripts/9router-fix.sh 4c7b3d3d-2b2a-4dcd-a7cf-b9864d520050 http://127.0.0.1:8792
#
# Reads the DB path from NINEROUTER_DB (default ~/9router-data/db/data.sqlite).
set -euo pipefail

TARGET="${1:-}"
BRIDGE_URL="${2:-http://127.0.0.1:8792}"
DB="${NINEROUTER_DB:-$HOME/9router-data/db/data.sqlite}"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

[[ -n "$TARGET" ]] || usage
[[ -f "$DB" ]] || { echo "error: db not found: $DB" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "error: sqlite3 required" >&2; exit 1; }

if [[ "$TARGET" == "list" ]]; then
  sqlite3 -header -column "$DB" \
    "SELECT provider,
            count(*)                          AS conns,
            json_extract(data,'\$.providerSpecificData.baseUrl') AS sampleBaseUrl
       FROM providerConnections
      WHERE provider LIKE 'openai-compatible-%'
      GROUP BY provider ORDER BY provider;"
  exit 0
fi

# ---------------------------------------------------------------- resolve ---
# TARGET may be a provider id, a connection id, or a providerNode id.
PROVIDER="$(
  sqlite3 "$DB" "
    SELECT coalesce(
      (SELECT provider FROM providerConnections WHERE provider = '$TARGET' LIMIT 1),
      (SELECT provider FROM providerConnections WHERE id       = '$TARGET' LIMIT 1),
      (SELECT id       FROM providerNodes
        WHERE id = '$TARGET' AND type LIKE 'openai-compatible-%' LIMIT 1),
      '');"
)"

if [[ -z "$PROVIDER" ]]; then
  echo "error: '$TARGET' is not a known provider, connection, or compatible node." >&2
  echo "hint: ./scripts/9router-fix.sh list" >&2
  exit 1
fi

CONN_COUNT="$(sqlite3 "$DB" "SELECT count(*) FROM providerConnections WHERE provider = '$PROVIDER';")"
echo "==> provider  : $PROVIDER"
echo "==> target    : $BRIDGE_URL"
echo "==> conns     : $CONN_COUNT"

if [[ "$CONN_COUNT" == "0" ]]; then
  echo "warning: no connections for this provider — only the node will be updated." >&2
fi

BACKUP="${DB}.pre-bridge-$(date +%Y%m%d-%H%M%S)"
cp "$DB" "$BACKUP"
echo "==> backup    : $BACKUP"

# ----------------------------------------------------------------- apply ----
# Provider node (the "compatible provider" definition used by the dashboard).
sqlite3 "$DB" "
  UPDATE providerNodes
     SET data = json_set(data, '\$.baseUrl', '$BRIDGE_URL'),
         updatedAt = datetime('now')
   WHERE id = '$PROVIDER';"

# Connections (what the executor reads on every request).
sqlite3 "$DB" "
  UPDATE providerConnections
     SET data = json_set(data,
           '\$.providerSpecificData.baseUrl', '$BRIDGE_URL',
           '\$.testStatus', NULL,
           '\$.errorCode', NULL,
           '\$.lastError', NULL,
           '\$.lastErrorAt', NULL,
           '\$.rateLimitedUntil', NULL,
           '\$.backoffLevel', 0),
         updatedAt = datetime('now')
   WHERE provider = '$PROVIDER';"

# Clear per-model cooldowns one key at a time. json_set on each key keeps every
# other field of `data` intact (never rebuild the whole JSON object).
MODEL_LOCKS="$(
  sqlite3 "$DB" "
    SELECT DISTINCT j.key
      FROM providerConnections c, json_each(c.data) j
     WHERE c.provider = '$PROVIDER' AND j.key LIKE 'modelLock_%';"
)"

if [[ -n "$MODEL_LOCKS" ]]; then
  while IFS= read -r lock_key; do
    [[ -n "$lock_key" ]] || continue
    sqlite3 "$DB" "
      UPDATE providerConnections
         SET data = json_set(data, '\$.${lock_key}', NULL),
             updatedAt = datetime('now')
       WHERE provider = '$PROVIDER';"
    echo "==> cleared lock: $lock_key"
  done <<<"$MODEL_LOCKS"
else
  echo "==> no model locks to clear"
fi

# ---------------------------------------------------------------- report ----
echo
echo "==> connections:"
sqlite3 -header -column "$DB" "
  SELECT id, name,
         json_extract(data,'\$.providerSpecificData.baseUrl') AS baseUrl,
         json_extract(data,'\$.errorCode')                    AS errorCode,
         json_extract(data,'\$.testStatus')                   AS testStatus
    FROM providerConnections WHERE provider = '$PROVIDER';"

echo
echo "==> node:"
sqlite3 -header -column "$DB" "
  SELECT id, json_extract(data,'\$.baseUrl') AS baseUrl FROM providerNodes WHERE id = '$PROVIDER';"

# sanity check: every connection of this provider must now point at the bridge
WRONG="$(
  sqlite3 "$DB" "
    SELECT count(*) FROM providerConnections
     WHERE provider = '$PROVIDER'
       AND json_extract(data,'\$.providerSpecificData.baseUrl') <> '$BRIDGE_URL';"
)"
if [[ "$WRONG" != "0" ]]; then
  echo >&2
  echo "error: $WRONG connection(s) still not pointing at the bridge — restore with:" >&2
  echo "       cp '$BACKUP' '$DB'" >&2
  exit 1
fi

echo
echo "done. 9Router reads providerConnections live — no restart needed."
echo "verify: curl http://127.0.0.1:<router-port>/v1/chat/completions \\"
echo "          -H 'Authorization: Bearer <router-key>' -H 'Content-Type: application/json' \\"
echo "          -d '{\"model\":\"<prefix>/<model>\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}'"
