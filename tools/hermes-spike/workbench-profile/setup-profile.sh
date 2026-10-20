#!/usr/bin/env bash
# Create/refresh the locked "workbench" Hermes profile WITHOUT touching the default profile.
# Idempotent: never overwrites an existing config.yaml or any existing .env value.
# Env: PROFILE (default workbench), HERMES_BIN (default: hermes on PATH), HERMES_PORT (default 8643).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${PROFILE:-workbench}"; HERMES_BIN="${HERMES_BIN:-hermes}"; PORT="${HERMES_PORT:-8643}"
command -v "$HERMES_BIN" >/dev/null || { echo "hermes not found. Install Hermes Agent first (https://hermes-agent.nousresearch.com/docs)." >&2; exit 1; }
BASE="${HERMES_HOME_ROOT:-$HOME/.hermes}"; PDIR="$BASE/profiles/$PROFILE"

if [ -d "$PDIR" ]; then echo "profile '$PROFILE' exists at $PDIR (kept)"
else
  # No --clone: nothing is copied from the default profile (no keys, memory or skills leak in).
  "$HERMES_BIN" profile create "$PROFILE" --no-alias --no-skills \
    --description "Workbench brain: read-only built-ins plus the Workbench MCP server."
fi
[ -d "$PDIR" ] || { echo "expected $PDIR after profile create" >&2; exit 1; }

if [ -e "$PDIR/config.yaml" ]; then
  echo "config.yaml exists, NOT overwritten. Compare with: diff $PDIR/config.yaml $HERE/config.yaml"
else
  cp "$HERE/config.yaml" "$PDIR/config.yaml"; echo "wrote $PDIR/config.yaml"
fi

ENVF="$PDIR/.env"; touch "$ENVF"; chmod 600 "$ENVF"
setkey() { # setkey NAME VALUE  (only if NAME= absent or empty)
  if grep -Eq "^$1=.+" "$ENVF"; then echo "  $1 already set (kept)"
  else grep -Ev "^$1=" "$ENVF" > "$ENVF.tmp" || true; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"
       printf '%s=%s\n' "$1" "$2" >> "$ENVF"; echo "  $1 set"; fi
}
echo "updating $ENVF"
setkey API_SERVER_ENABLED true
setkey API_SERVER_HOST 127.0.0.1
setkey API_SERVER_PORT "$PORT"
if ! grep -Eq "^API_SERVER_KEY=.+" "$ENVF"; then setkey API_SERVER_KEY "$(openssl rand -hex 32)"; else echo "  API_SERVER_KEY already set (kept)"; fi
if [ -n "${WORKBENCH_TOKEN:-}" ]; then setkey WORKBENCH_TOKEN "$WORKBENCH_TOKEN"; fi
grep -Eq "^WORKBENCH_TOKEN=.+" "$ENVF" || echo "  WORKBENCH_TOKEN missing: add the contents of \$WORKBENCH_DATA_DIR/token (or rerun with WORKBENCH_TOKEN=...)"

cat <<EOF

Next steps
  1. Pick the LLM:      $HERMES_BIN -p $PROFILE model        (or: $HERMES_BIN -p $PROFILE setup)
  2. Start the brain:   $HERMES_BIN -p $PROFILE gateway run  (or: $HERMES_BIN -p $PROFILE gateway start)
  3. Point Workbench at: HERMES_URL=http://127.0.0.1:$PORT/v1   HERMES_API_KEY=\$(grep '^API_SERVER_KEY=' "$ENVF" | cut -d= -f2-)
  4. Verify lock:       curl -s -H "Authorization: Bearer <key>" http://127.0.0.1:$PORT/v1/toolsets   (no terminal/file/browser)
The default profile (~/.hermes) was not modified.
EOF
