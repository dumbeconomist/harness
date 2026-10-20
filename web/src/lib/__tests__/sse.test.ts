import { describe, expect, it, vi } from 'vitest';
import { connectEvents, createSseParser, streamChat, type SseMessage } from '../sse';

function collect() {
  const out: SseMessage[] = [];
  return { out, parser: createSseParser((m) => out.push(m)) };
}

describe('SSE parser', () => {
  it('parses named events split across chunks', () => {
    const { out, parser } = collect();
    parser.push('event: delta\ndata: {"te');
    parser.push('xt":"hi"}\n\nevent: done\ndata: {}\n\n');
    expect(out).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'done', data: '{}' },
    ]);
  });
  it('handles CRLF, comments and multi-line data', () => {
    const { out, parser } = collect();
    parser.push(': keepalive\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(out).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
  it('flush dispatches a trailing unterminated event', () => {
    const { out, parser } = collect();
    parser.push('event: done\ndata: {}');
    parser.flush();
    expect(out).toHaveLength(1);
  });
});

const cfg = { baseUrl: 'http://x', token: 't' };

describe('tool status mapping', () => {
  it('passes failed and maps unknown statuses to unknown', async () => {
    const enc = new TextEncoder();
    const f = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('event: tool\ndata: {"tool":"t","status":"failed"}\n\nevent: tool\ndata: {"tool":"t","status":"weird"}\n\nevent: done\ndata: {}\n\n')); c.close(); } })),
    );
    const onTool = vi.fn();
    await streamChat(cfg, { messages: [] }, { onDelta: vi.fn(), onDone: vi.fn(), onTool, onError: vi.fn() }, undefined, f);
    expect(onTool.mock.calls).toEqual([['t', 'failed'], ['t', 'unknown']]);
  });
});

describe('tool events', () => {
  it('parser yields tool events; streamChat routes them and ignores unknown events', async () => {
    const enc = new TextEncoder();
    const f = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('event: tool\ndata: {"tool":"mcp__workbench__tasks_create","status":"running"}\n\nevent: mystery\ndata: {}\n\nevent: tool\ndata: {"tool":"mcp__workbench__tasks_create","status":"completed"}\n\nevent: done\ndata: {}\n\n'));
            c.close();
          },
        }),
      ),
    );
    const onTool = vi.fn();
    const onError = vi.fn();
    await streamChat(cfg, { messages: [], session_id: 's1' }, { onDelta: vi.fn(), onDone: vi.fn(), onTool, onError }, undefined, f);
    expect(onTool.mock.calls).toEqual([
      ['mcp__workbench__tasks_create', 'running'],
      ['mcp__workbench__tasks_create', 'completed'],
    ]);
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string).session_id).toBe('s1');
  });
});

function streamOf(...chunks: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        chunks.forEach((x) => c.enqueue(enc.encode(x)));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('streamChat', () => {
  it('emits deltas then done, sending context + auth', async () => {
    const f = vi.fn().mockResolvedValue(
      streamOf('event: delta\ndata: {"text":"Hel"}\n\nevent: delta\ndata: {"text":"lo"}\n\n', 'event: done\ndata: {"usage":{"total_tokens":3}}\n\n'),
    );
    const deltas: string[] = [];
    const onDone = vi.fn();
    const onError = vi.fn();
    await streamChat(cfg, { messages: [{ role: 'user', content: 'x' }], context: { kind: 'task', id: '1' } }, { onDelta: (t) => deltas.push(t), onDone, onError }, undefined, f);
    expect(deltas.join('')).toBe('Hello');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith({ total_tokens: 3 });
    expect(onError).not.toHaveBeenCalled();
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).context).toEqual({ kind: 'task', id: '1' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });
  it('reports error events', async () => {
    const f = vi.fn().mockResolvedValue(streamOf('event: error\ndata: {"message":"boom"}\n\n'));
    const onError = vi.fn();
    const onDone = vi.fn();
    await streamChat(cfg, { messages: [] }, { onDelta: vi.fn(), onDone, onError }, undefined, f);
    expect(onError).toHaveBeenCalledWith('boom');
    expect(onDone).not.toHaveBeenCalled();
  });
  it('reports unreachable on network failure', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const onError = vi.fn();
    await streamChat(cfg, { messages: [] }, { onDelta: vi.fn(), onDone: vi.fn(), onError }, undefined, f);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Hermes unreachable'));
  });
  it('surfaces HTTP error message', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 401 }));
    const onError = vi.fn();
    await streamChat(cfg, { messages: [] }, { onDelta: vi.fn(), onDone: vi.fn(), onError }, undefined, f);
    expect(onError).toHaveBeenCalledWith('bad token');
  });
});

class FakeES {
  static instances: FakeES[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  listeners: Record<string, (e: MessageEvent) => void> = {};
  closed = false;
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    this.listeners[t] = fn;
  }
  close() {
    this.closed = true;
  }
}

describe('connectEvents', () => {
  it('passes token, dispatches events, reconnects with backoff', () => {
    vi.useFakeTimers();
    FakeES.instances = [];
    const events: unknown[] = [];
    const statuses: string[] = [];
    const dispose = connectEvents({
      cfg,
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      EventSourceImpl: FakeES as unknown as typeof EventSource,
      baseDelayMs: 100,
    });
    const first = FakeES.instances[0]!;
    expect(first.url).toBe('http://x/api/events?token=t');
    first.onopen?.();
    first.onmessage?.({ data: '{"type":"task.changed","payload":{"id":"1"}}' } as MessageEvent);
    first.listeners['approval.created']?.({ data: '{"id":"a"}' } as MessageEvent);
    first.onmessage?.({ data: '{"type":"nope","payload":1}' } as MessageEvent);
    expect(events).toEqual([
      { type: 'task.changed', payload: { id: '1' } },
      { type: 'approval.created', payload: { id: 'a' } },
    ]);
    first.onerror?.();
    expect(first.closed).toBe(true);
    expect(statuses).toEqual(['connecting', 'open', 'lost']);
    vi.advanceTimersByTime(100);
    expect(FakeES.instances).toHaveLength(2);
    FakeES.instances[1]!.onerror?.();
    vi.advanceTimersByTime(150);
    expect(FakeES.instances).toHaveLength(2); // second delay is 200ms
    vi.advanceTimersByTime(60);
    expect(FakeES.instances).toHaveLength(3);
    dispose();
    vi.useRealTimers();
  });
});
