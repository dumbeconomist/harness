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
| `POST /v1/chat/completions` | `stream: true` gives SSE word chunks, optional `stream_options.include_usage` usage chunk, then `[DONE]`. Otherwise a `chat.completion` JSON |

The reply is deterministic: `Mock Hermes heard: <last user message>`. Usage counts are word counts.

## Triggers

Matched in the last user message:

- `__error__`: HTTP 500 JSON error (before any streaming starts)
- `__slow__`: 200 ms delay per streamed chunk (default 10 ms)

## Auth

If `MOCK_HERMES_KEY` is set, every `/v1/*` route requires `Authorization: Bearer <key>`,
otherwise `401`. Header values are never logged. Each request logs one line:
`METHOD /path STATUS`.

## Tests

```sh
node --test tools/mock-hermes/server.test.js
```

Note: `node --test tools/mock-hermes/` (a directory) runs zero tests on Node 22. Pass the file
path, or run `pnpm test` from inside this directory.
