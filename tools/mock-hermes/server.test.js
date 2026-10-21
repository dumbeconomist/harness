import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { start } from "./server.js";

const REPLY_PREFIX = "Mock Hermes heard:";

// Parse an SSE body into its JSON payloads (in order). "[DONE]" is returned as the string.
function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      assert.ok(block.startsWith("data: "), `unexpected SSE block: ${block}`);
      const data = block.slice("data: ".length);
      return data === "[DONE]" ? "[DONE]" : JSON.parse(data);
    });
}

async function startServer(options = {}) {
  const logs = [];
  // mcpUrl/mcpToken default to null so a MOCK_HERMES_MCP_* env var cannot enable the agent loop.
  const server = start(0, { log: (line) => logs.push(line), mcpUrl: null, mcpToken: null, ...options });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, logs };
}

describe("mock-hermes without auth", () => {
  let ctx;
  before(async () => {
    ctx = await startServer({ key: "" });
  });
  after(() => new Promise((resolve) => ctx.server.close(resolve)));

  test("GET /health returns ok", async () => {
    const res = await fetch(`${ctx.base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  test("GET /v1/models lists hermes-agent", async () => {
    const res = await fetch(`${ctx.base}/v1/models`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      object: "list",
      data: [{ id: "hermes-agent", object: "model", owned_by: "hermes" }],
    });
  });

  test("non-stream chat returns chat.completion with usage", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "hello there" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "hermes-agent");
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].index, 0);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.choices[0].message, {
      role: "assistant",
      content: `${REPLY_PREFIX} hello there`,
    });
    // prompt: "be nice" + "first" + "ok" + "hello there" = 6 words
    // completion: "Mock Hermes heard: hello there" = 5 words
    assert.deepEqual(body.usage, { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 });
  });

  test("non-stream echoes a requested model id", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal((await res.json()).model, "gpt-x");
  });

  test("streaming emits word chunks, then [DONE]", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "hello there" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);

    const events = parseSse(await res.text());
    assert.equal(events.at(-1), "[DONE]");

    const chunks = events.slice(0, -1);
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.model, "hermes-agent");
    }
    assert.equal(chunks[0].choices[0].delta.role, "assistant");

    const contentChunks = chunks.filter((c) => c.choices.length === 1 && "content" in c.choices[0].delta);
    assert.ok(contentChunks.length > 1, "reply should be split into several chunks");
    const text = contentChunks.map((c) => c.choices[0].delta.content).join("");
    assert.equal(text, `${REPLY_PREFIX} hello there`);

    const final = chunks.at(-1);
    assert.equal(final.choices[0].finish_reason, "stop");

    // No usage chunk unless requested.
    assert.ok(chunks.every((c) => !("usage" in c)));
  });

  test("stream_options.include_usage adds a final usage-only chunk", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hello there" }],
      }),
    });
    const events = parseSse(await res.text());
    assert.equal(events.at(-1), "[DONE]");
    const usageChunk = events.at(-2);
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 });
  });

  test("__error__ in last user message returns HTTP 500 (non-stream)", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "boom __error__" }] }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.type, "server_error");
    assert.match(body.error.message, /__error__/);
  });

  test("__error__ in last user message returns HTTP 500 (stream)", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "__error__" }] }),
    });
    assert.equal(res.status, 500);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal((await res.json()).error.type, "server_error");
  });

  test("__error__ only in an earlier message does not trigger", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "__error__" },
          { role: "assistant", content: "x" },
          { role: "user", content: "fine now" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, `${REPLY_PREFIX} fine now`);
  });

  test("__slow__ delays each streamed chunk", async () => {
    const started = Date.now();
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "__slow__ one two" }],
      }),
    });
    const events = parseSse(await res.text());
    const contentChunks = events
      .slice(0, -1)
      .filter((c) => c.choices.length === 1 && "content" in c.choices[0].delta);
    assert.ok(Date.now() - started >= contentChunks.length * 200 - 50);
  });

  test("malformed JSON returns 400", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`${ctx.base}/nope`);
    assert.equal(res.status, 404);
  });

  test("logs one line per request with method, path and status", async () => {
    const before = ctx.logs.length;
    await (await fetch(`${ctx.base}/v1/models?x=1`)).text();
    const added = ctx.logs.slice(before);
    assert.deepEqual(added, ["GET /v1/models 200"]);
  });
});

describe("mock-hermes with MOCK_HERMES_KEY-style auth", () => {
  const KEY = "sekrit-test-key";
  let ctx;
  before(async () => {
    ctx = await startServer({ key: KEY });
  });
  after(() => new Promise((resolve) => ctx.server.close(resolve)));

  test("/v1/models without a bearer header returns 401", async () => {
    const res = await fetch(`${ctx.base}/v1/models`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, "authentication_error");
  });

  test("/v1/chat/completions with a wrong key returns 401", async () => {
    const res = await fetch(`${ctx.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
  });

  test("correct bearer key is accepted", async () => {
    const res = await fetch(`${ctx.base}/v1/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    assert.equal(res.status, 200);
  });

  test("/health stays open for readiness probes", async () => {
    const res = await fetch(`${ctx.base}/health`);
    assert.equal(res.status, 200);
  });

  test("logs never include the Authorization header value", async () => {
    await fetch(`${ctx.base}/v1/models`, {
      headers: { Authorization: "Bearer sekrit-leak-check" },
    }).then((r) => r.text());
    const joined = ctx.logs.join("\n");
    assert.ok(!joined.includes("sekrit-leak-check"));
    assert.ok(!joined.includes(KEY));
    assert.ok(!/authorization/i.test(joined));
    // The header value used here is wrong, so the request is rejected with 401.
    assert.equal(ctx.logs.at(-1), "GET /v1/models 401");
  });
});

// --- Agent loop: "add a task" -> Workbench MCP tasks_create -----------------

const MCP_TOKEN = "tok-123";

// Minimal fake Workbench MCP endpoint (JSON-RPC over HTTP). Records every request it receives.
async function startFakeMcp(onToolCall = async () => ({ content: [{ type: "text", text: "ok" }] })) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    calls.push({ method: msg.method, headers: req.headers, params: msg.params ?? null });

    if (msg.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
    const reply = (result) => {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    if (msg.method === "initialize") {
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-workbench", version: "0.0.0" },
      });
    }
    if (msg.method === "tools/call") return reply(await onToolCall(msg.params));
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function streamTask(base, content) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content }],
    }),
  });
}

// Parse SSE into {event, data} blocks. Named events have event set; data "[DONE]" stays a string.
function parseEvents(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event = null;
      let data = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) data = line.slice("data: ".length);
      }
      return { event, data: data === "[DONE]" ? "[DONE]" : JSON.parse(data) };
    });
}

const progressOf = (events) => events.filter((e) => e.event === "hermes.tool.progress");
const replyText = (events) =>
  events
    .filter((e) => e.event === null && e.data !== "[DONE]")
    .flatMap((e) => e.data.choices)
    .map((c) => c.delta?.content ?? "")
    .join("");

describe("mock-hermes agent loop (add a task)", () => {
  test("success: running, then completed, then 'Added task', usage, [DONE]; MCP call shape and auth", async () => {
    const mcp = await startFakeMcp(async () => ({
      content: [{ type: "text", text: '{"id":"t_1"}' }],
      structuredContent: { id: "t_1" },
    }));
    const ctx = await startServer({ mcpUrl: mcp.url, mcpToken: MCP_TOKEN });
    try {
      const res = await streamTask(ctx.base, "please add a task to buy milk");
      assert.equal(res.status, 200);
      const events = parseEvents(await res.text());

      const progress = progressOf(events);
      assert.deepEqual(progress.map((e) => e.data.status), ["running", "completed"]);
      assert.equal(progress[0].data.tool, "mcp__workbench__tasks_create");
      assert.ok(progress[0].data.toolCallId);
      assert.equal(progress[1].data.toolCallId, progress[0].data.toolCallId);

      assert.equal(replyText(events), "Added task: buy milk");
      assert.equal(events.at(-1).data, "[DONE]");
      const usageChunk = events.at(-2).data;
      assert.deepEqual(usageChunk.choices, []);
      assert.equal(usageChunk.usage.completion_tokens, 4); // "Added task: buy milk"

      assert.deepEqual(mcp.calls.map((c) => c.method), [
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      assert.equal(mcp.calls[0].params.protocolVersion, "2025-06-18");
      assert.deepEqual(mcp.calls[2].params, { name: "tasks_create", arguments: { title: "buy milk" } });
      for (const call of mcp.calls) {
        assert.equal(call.headers.authorization, `Bearer ${MCP_TOKEN}`);
        assert.match(call.headers.accept, /application\/json/);
        assert.match(call.headers.accept, /text\/event-stream/);
      }
      assert.equal(mcp.calls[2].headers["mcp-session-id"], "sess-1");
    } finally {
      await ctx.server.close();
      await mcp.close();
    }
  });

  test("isError result: completed status, then 'Could not add task: <content text>'", async () => {
    const mcp = await startFakeMcp(async () => ({
      isError: true,
      content: [{ type: "text", text: "Denied by user: not now" }],
    }));
    const ctx = await startServer({ mcpUrl: mcp.url, mcpToken: MCP_TOKEN });
    try {
      const events = parseEvents(await (await streamTask(ctx.base, "add task to buy milk")).text());
      assert.deepEqual(progressOf(events).map((e) => e.data.status), ["running", "completed"]);
      assert.equal(replyText(events), "Could not add task: Denied by user: not now");
      assert.equal(events.at(-1).data, "[DONE]");
    } finally {
      await ctx.server.close();
      await mcp.close();
    }
  });

  test("event ordering: running is streamed before the blocking call finishes; completed precedes text", async () => {
    let arrive;
    const arrived = new Promise((resolve) => (arrive = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const mcp = await startFakeMcp(async () => {
      arrive();
      await gate; // simulate a human deciding later
      return { content: [{ type: "text", text: "ok" }] };
    });
    const ctx = await startServer({ mcpUrl: mcp.url, mcpToken: MCP_TOKEN });
    try {
      const res = await streamTask(ctx.base, "add task to buy milk");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!buf.includes('"status":"running"')) {
        const { done, value } = await reader.read();
        assert.ok(!done, "stream ended before running event");
        buf += decoder.decode(value, { stream: true });
      }
      // The running event arrived while the MCP call is still waiting on the human decision.
      await arrived;
      assert.ok(!buf.includes("Added task"), "no reply text before the tool finishes");
      release();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }

      const events = parseEvents(buf);
      const statuses = progressOf(events).map((e) => e.data.status);
      assert.deepEqual(statuses, ["running", "completed"]);
      const runningIdx = events.findIndex((e) => e.data?.status === "running");
      const completedIdx = events.findIndex((e) => e.data?.status === "completed");
      const firstTextIdx = events.findIndex((e) => e.event === null && e.data !== "[DONE]" && e.data.choices?.[0]?.delta?.content);
      assert.ok(runningIdx < completedIdx && completedIdx < firstTextIdx);
      assert.equal(replyText(events), "Added task: buy milk");
    } finally {
      release();
      await ctx.server.close();
      await mcp.close();
    }
  });

  test("transport failure: running, failed, then 'Could not add task: <error>'", async () => {
    const ctx = await startServer({ mcpUrl: "http://127.0.0.1:1/mcp", mcpToken: MCP_TOKEN });
    try {
      const events = parseEvents(await (await streamTask(ctx.base, "add task to buy milk")).text());
      assert.deepEqual(progressOf(events).map((e) => e.data.status), ["running", "failed"]);
      const text = replyText(events);
      assert.ok(text.startsWith("Could not add task: "), text);
      assert.equal(events.at(-1).data, "[DONE]");
    } finally {
      await ctx.server.close();
    }
  });

  test("non-matching message never calls MCP", async () => {
    const mcp = await startFakeMcp();
    const ctx = await startServer({ mcpUrl: mcp.url, mcpToken: MCP_TOKEN });
    try {
      const events = parseEvents(await (await streamTask(ctx.base, "hello there")).text());
      assert.equal(progressOf(events).length, 0);
      assert.equal(replyText(events), "Mock Hermes heard: hello there");
      assert.equal(mcp.calls.length, 0);
    } finally {
      await ctx.server.close();
      await mcp.close();
    }
  });

  test("non-streaming request never calls MCP", async () => {
    const mcp = await startFakeMcp();
    const ctx = await startServer({ mcpUrl: mcp.url, mcpToken: MCP_TOKEN });
    try {
      const res = await fetch(`${ctx.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "add a task to buy milk" }] }),
      });
      assert.equal((await res.json()).choices[0].message.content, "Mock Hermes heard: add a task to buy milk");
      assert.equal(mcp.calls.length, 0);
    } finally {
      await ctx.server.close();
      await mcp.close();
    }
  });

  test("loop stays off unless both URL and token are set", async () => {
    const mcp = await startFakeMcp();
    const ctx = await startServer({ mcpUrl: mcp.url, mcpToken: null });
    try {
      const events = parseEvents(await (await streamTask(ctx.base, "add task to buy milk")).text());
      assert.equal(progressOf(events).length, 0);
      assert.equal(replyText(events), "Mock Hermes heard: add task to buy milk");
      assert.equal(mcp.calls.length, 0);
    } finally {
      await ctx.server.close();
      await mcp.close();
    }
  });
});

// --- Toolsets: GET /v1/toolsets (used by the Doctor's profile_locked check) --

const DEFAULT_TOOLSETS = [
  { name: "terminal", enabled: false },
  { name: "file", enabled: false },
  { name: "web", enabled: true },
];

// Runs fn with the given env vars set (undefined deletes), restoring the previous values after.
async function withEnv(vars, fn) {
  const saved = {};
  for (const name of Object.keys(vars)) {
    saved[name] = process.env[name];
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  }
  try {
    return await fn();
  } finally {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

describe("mock-hermes toolsets", () => {
  test("default: terminal and file disabled, web enabled", async () => {
    await withEnv({ MOCK_HERMES_UNLOCKED: undefined, MOCK_HERMES_NO_TOOLSETS: undefined }, async () => {
      const ctx = await startServer({ key: "" });
      try {
        const res = await fetch(`${ctx.base}/v1/toolsets`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /application\/json/);
        assert.deepEqual(await res.json(), DEFAULT_TOOLSETS);
      } finally {
        await new Promise((resolve) => ctx.server.close(resolve));
      }
    });
  });

  test("unlocked option: terminal and file enabled", async () => {
    const ctx = await startServer({ key: "", unlocked: true });
    try {
      const res = await fetch(`${ctx.base}/v1/toolsets`);
      assert.deepEqual(await res.json(), [
        { name: "terminal", enabled: true },
        { name: "file", enabled: true },
        { name: "web", enabled: true },
      ]);
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  });

  test("MOCK_HERMES_UNLOCKED=1 enables terminal and file", async () => {
    await withEnv({ MOCK_HERMES_UNLOCKED: "1", MOCK_HERMES_NO_TOOLSETS: undefined }, async () => {
      const ctx = await startServer({ key: "" });
      try {
        const body = await (await fetch(`${ctx.base}/v1/toolsets`)).json();
        assert.deepEqual(body.map((t) => t.enabled), [true, true, true]);
      } finally {
        await new Promise((resolve) => ctx.server.close(resolve));
      }
    });
  });

  test("noToolsets option: GET /v1/toolsets returns 404", async () => {
    const ctx = await startServer({ key: "", noToolsets: true });
    try {
      const res = await fetch(`${ctx.base}/v1/toolsets`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.type, "not_found");
      // Other routes are unaffected.
      assert.equal((await fetch(`${ctx.base}/v1/models`)).status, 200);
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  });

  test("MOCK_HERMES_NO_TOOLSETS=1 makes GET /v1/toolsets return 404", async () => {
    await withEnv({ MOCK_HERMES_NO_TOOLSETS: "1", MOCK_HERMES_UNLOCKED: undefined }, async () => {
      const ctx = await startServer({ key: "" });
      try {
        assert.equal((await fetch(`${ctx.base}/v1/toolsets`)).status, 404);
      } finally {
        await new Promise((resolve) => ctx.server.close(resolve));
      }
    });
  });

  test("/v1/toolsets without a bearer header returns 401 when a key is set", async () => {
    const ctx = await startServer({ key: "tools-key" });
    try {
      const res = await fetch(`${ctx.base}/v1/toolsets`);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.type, "authentication_error");
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  });

  test("/v1/toolsets with a wrong bearer key returns 401; the right key returns the list", async () => {
    const ctx = await startServer({ key: "tools-key" });
    try {
      const wrong = await fetch(`${ctx.base}/v1/toolsets`, {
        headers: { Authorization: "Bearer nope" },
      });
      assert.equal(wrong.status, 401);
      const right = await fetch(`${ctx.base}/v1/toolsets`, {
        headers: { Authorization: "Bearer tools-key" },
      });
      assert.equal(right.status, 200);
      assert.deepEqual(await right.json(), DEFAULT_TOOLSETS);
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  });

  test("non-stream chat with max_tokens:1 still returns a chat.completion (doctor deep check)", async () => {
    const ctx = await startServer({ key: "" });
    try {
      const res = await fetch(`${ctx.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, "chat.completion");
      assert.equal(body.choices[0].message.content, `${REPLY_PREFIX} ping`);
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  });

  test("__error__ still returns 500 with max_tokens:1 (non-stream)", async () => {
    const ctx = await startServer({ key: "" });
    try {
      const res = await fetch(`${ctx.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1, messages: [{ role: "user", content: "__error__" }] }),
      });
      assert.equal(res.status, 500);
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  });
});
