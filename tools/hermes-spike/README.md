# Hermes spike (fake LLM + fake Workbench MCP)

Re-runnable verification that Hermes Agent 0.19.0 registers an HTTP MCP server from `config.yaml`,
calls its tool, and serves streaming `/v1/chat/completions` on :8642. Results: `docs/hermes-integration.md`.

- `fake_llm.py`  OpenAI-compatible stub (:9100). First call returns a `tool_call` to `*tasks_create`, second a final answer. Streams usage.
- `fake_mcp.py`  Streamable-HTTP MCP stub (:8765/mcp, JSON responses, bearer `spike-token`). `TOOL_SLEEP=<s>` delays `tools/call`. Logs to `fake_mcp.log`.
- `example-home/` the exact `config.yaml` / `.env` used as `HERMES_HOME`.
- `run.sh [workdir]` creates a venv, installs `hermes-agent==0.19.0` + `mcp==1.26.0` + `aiohttp==3.14.1`, starts everything, prints the SSE stream.

Needs Python >= 3.11 and PyPI access. Never run against your real `~/.hermes` (HERMES_HOME is overridden).
Gotchas: plain `pip install hermes-agent` lacks `mcp` and `aiohttp` (extras `mcp`, `messaging`); `API_SERVER_KEY` must be >= 16 chars.
