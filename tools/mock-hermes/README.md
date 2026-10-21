# mock-hermes

Dependency-free Node 22 mock of Hermes Agent's OpenAI-compatible API server. Used by core,
web and e2e tests, and for offline dev when no real Hermes is running.

## Run

```sh
node tools/mock-hermes/server.js            # or: pnpm -C tools/mock-hermes start
MOCK_HERMES_PORT=8642 MOCK_HERMES_KEY=dev-key node tools/mock-hermes/server.js
```

Listens on `127.0.0.1` only. Default port `8642`.

## Endpoints

| Route | Notes |
|---|---|
| `GET /health` | always open, returns `{"status":"ok"}` |
| `GET /v1/models` | lists `hermes-agent` |
| `GET /v1/toolsets` | JSON array of `{name, enabled}`: `terminal` and `file` disabled, `web` enabled. `MOCK_HERMES_UNLOCKED=1` (or `start(..., {unlocked: true})`) enables `terminal` and `file`. `MOCK_HERMES_NO_TOOLSETS=1` (or `{noToolsets: true}`) makes it return `404`. Needs the bearer key like other `/v1/*` routes |
| `POST /v1/chat/completions` | `stream: true` gives SSE word chunks, optional `stream_options.include_usage` usage chunk, then `[DONE]`. Otherwise a `chat.completion` JSON |

The reply is deterministic: `Mock Hermes heard: <last user message>`. Usage counts are word counts.

## Triggers

Matched in the last user message:

- `__error__`: HTTP 500 JSON error (before any streaming starts)
- `__slow__`: 200 ms delay per streamed chunk (default 10 ms)

## Toolsets and the Doctor

`GET /v1/toolsets` is what the Doctor's `profile_locked` check reads. The default profile is locked
(`terminal` and `file` disabled). Use `MOCK_HERMES_UNLOCKED=1` to get a profile the check fails on, and
`MOCK_HERMES_NO_TOOLSETS=1` to get a Hermes without the endpoint, where the check can only warn.

The Doctor's deep check (`hermes_model`) sends a non-stream `max_tokens: 1` request. The mock ignores
`max_tokens` and returns the normal reply. `__error__` still gives a 500 for that request.

## Agent loop: "add a task"

Set both `MOCK_HERMES_MCP_URL` (Workbench `/mcp` endpoint) and `MOCK_HERMES_MCP_TOKEN` (its bearer
token) to enable it. Both can also be passed as `start(port, {mcpUrl, mcpToken})`. Pass `null` to
disable explicitly.

When a **streaming** request's last user message matches `/add (?:a )?task(?: to)? (.+)/i`:

1. Emits a named SSE event `event: hermes.tool.progress` with
   `{"tool":"mcp__workbench__tasks_create","toolCallId":"call_mock_N","status":"running"}`.
2. Calls the MCP endpoint over JSON-RPC: `initialize` (protocol `2025-06-18`),
   `notifications/initialized`, then `tools/call` `tasks_create {title}`. Each request sends
   `Authorization: Bearer <token>`. There is no client timeout, so the call blocks until a human
   approves or denies it.
3. Emits the same event with `status: "completed"`. The tool's `isError` result is handled as
   a completed call.
4. Streams `Added task: <title>`, or `Could not add task: <content[0].text>` on `isError`. Then the
   usage chunk (if requested) and `[DONE]`.

A transport failure (network error, HTTP error, JSON-RPC error) emits `status: "failed"` and streams
`Could not add task: <error message>`. `failed` is an addition to the spec's `running`/`completed`.

Non-streaming requests and messages that don't match never touch MCP.

## Auth

If `MOCK_HERMES_KEY` is set, every `/v1/*` route requires `Authorization: Bearer <key>`,
otherwise `401`. Header values are never logged. Each request logs one line:
`METHOD /path STATUS`.

## Tests

```sh
node --test tools/mock-hermes/server.test.js
```

The suite includes an in-process fake MCP server for the agent loop. It also covers `/v1/toolsets` (default, unlocked by option and env, 404, 401) and the `max_tokens: 1` deep check.

Note: `node --test tools/mock-hermes/` (a directory) runs zero tests on Node 22. Pass the file
path, or run `pnpm test` from inside this directory.
