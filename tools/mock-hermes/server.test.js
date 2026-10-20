import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
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
  const server = start(0, { log: (line) => logs.push(line), ...options });
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
