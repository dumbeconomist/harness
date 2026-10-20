// Mock of Hermes Agent's OpenAI-compatible API server.
// Dependency-free (Node 22+). Used by core/web/e2e tests and offline dev.
//
// Env:
//   MOCK_HERMES_PORT  listen port (default 8642)
//   MOCK_HERMES_KEY   if set, /v1/* requires "Authorization: Bearer <key>"
//
// Test triggers (matched in the last user message):
//   __error__  -> HTTP 500 JSON error
//   __slow__   -> 200ms delay per streamed chunk

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const MODEL_ID = "hermes-agent";
const CHUNK_DELAY_MS = 10;
const SLOW_CHUNK_DELAY_MS = 200;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_PORT = 8642;

let idCounter = 0;

class HttpError extends Error {
  constructor(status, message, type = "invalid_request_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, message, type) {
  sendJson(res, status, { error: { message, type, param: null, code: null } });
}

function isAuthorized(req, key) {
  if (!key) return true;
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${key}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join(" ");
  }
  return "";
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i].content);
  }
  return "";
}

const countWords = (s) => s.split(/\s+/).filter(Boolean).length;

function usageFor(messages, reply) {
  const prompt_tokens = messages.reduce((n, m) => n + countWords(textOf(m?.content)), 0);
  const completion_tokens = countWords(reply);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleChat(req, res, body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new HttpError(400, "'messages' must be an array");

  const userText = lastUserText(messages);
  if (userText.includes("__error__")) {
    throw new HttpError(500, "Mock Hermes failure (__error__ trigger)", "server_error");
  }

  const model = typeof body.model === "string" && body.model ? body.model : MODEL_ID;
  const reply = `Mock Hermes heard: ${userText}`;
  const usage = usageFor(messages, reply);
  const id = `chatcmpl-mock-${++idCounter}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream !== true) {
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
      ],
      usage,
    });
    return;
  }

  const delay = userText.includes("__slow__") ? SLOW_CHUNK_DELAY_MS : CHUNK_DELAY_MS;
  const includeUsage = body.stream_options?.include_usage === true;
  const pieces = reply.match(/\S+\s*/g) ?? [];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const base = { id, object: "chat.completion.chunk", created, model };
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for (let i = 0; i < pieces.length; i++) {
    if (res.destroyed) return;
    await sleep(delay);
    const delta = i === 0 ? { role: "assistant", content: pieces[i] } : { content: pieces[i] };
    write({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  }
  if (res.destroyed) return;
  write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (includeUsage) write({ ...base, choices: [], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

function route(req, res, pathname, key) {
  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (pathname.startsWith("/v1/") && !isAuthorized(req, key)) {
    return sendError(res, 401, "Invalid or missing API key", "authentication_error");
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: MODEL_ID, object: "model", owned_by: "hermes" }],
    });
  }

  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    return readJson(req)
      .then((body) => handleChat(req, res, body))
      .catch((err) => {
        if (res.headersSent) {
          res.destroy(err);
          return;
        }
        if (err instanceof HttpError) {
          return sendError(res, err.status, err.message, err.type);
        }
        return sendError(res, 500, "Internal mock error", "server_error");
      });
  }

  return sendError(res, 404, `No route for ${req.method} ${pathname}`, "not_found");
}

/**
 * Create and start the mock server on 127.0.0.1.
 * Listening is asynchronous: wait for the server's 'listening' event.
 *
 * @param {number} [port] port to listen on; 0 picks a free port
 * @param {{ key?: string, log?: (line: string) => void }} [options]
 *   key: bearer key to enforce on /v1/* (defaults to MOCK_HERMES_KEY)
 *   log: sink for request log lines (defaults to console.log)
 * @returns {http.Server}
 */
export function start(port = defaultPort(), options = {}) {
  const key = options.key ?? process.env.MOCK_HERMES_KEY ?? "";
  const log = options.log ?? console.log;

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    res.on("finish", () => {
      // Never log headers: Authorization must not reach stdout.
      log(`${req.method} ${pathname} ${res.statusCode}`);
    });
    route(req, res, pathname, key || null);
  });

  server.listen(port, "127.0.0.1");
  return server;
}

function defaultPort() {
  const raw = process.env.MOCK_HERMES_PORT;
  return raw ? Number(raw) : DEFAULT_PORT;
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = start(defaultPort());
  server.on("listening", () => {
    console.log(`mock-hermes listening on http://127.0.0.1:${server.address().port}`);
  });
  server.on("error", (err) => {
    console.error(`mock-hermes failed to start: ${err.message}`);
    process.exit(1);
  });
}
