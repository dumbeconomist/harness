#!/bin/bash
# Re-run the Hermes spike. Usage: tools/hermes-spike/run.sh [workdir]   (default /tmp/hermes-spike)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; W="${1:-/tmp/hermes-spike}"
mkdir -p "$W/home" "$W/run"
[ -d "$W/venv" ] || { python3 -m venv "$W/venv"; "$W/venv/bin/pip" install -q hermes-agent==0.19.0 "mcp==1.26.0" "aiohttp==3.14.1"; }
cp "$HERE/example-home/config.yaml" "$W/home/config.yaml"
grep -v '^#' "$HERE/example-home/env.example" | sed 's/ *#.*//' > "$W/home/.env"
export HERMES_HOME="$W/home"; cd "$W/run"
python3 "$HERE/fake_llm.py" & python3 "$HERE/fake_mcp.py" &
echo "== hermes mcp test"; "$W/venv/bin/hermes" mcp test workbench
"$W/venv/bin/hermes" gateway run > gw.out 2>&1 &
GW=$!; trap 'kill $GW $(jobs -p) 2>/dev/null' EXIT
for i in $(seq 60); do curl -sf localhost:8642/health >/dev/null && break; sleep 1; done
echo "== streaming chat completion"
curl -sN -m60 localhost:8642/v1/chat/completions -H "Authorization: Bearer spike-key-0123456789abcdef" \
  -H "Content-Type: application/json" -H "X-Hermes-Session-Id: spike-1" \
  -d '{"model":"hermes-agent","stream":true,"messages":[{"role":"user","content":"make a task"}]}'
echo "== fake_mcp.log"; cat fake_mcp.log
