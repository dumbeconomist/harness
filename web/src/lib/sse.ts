import type { WorkbenchConfig } from './config';
import { EVENT_TYPES, type ChatRequest, type WorkbenchEvent, type WorkbenchEventType } from './types';

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental text/event-stream parser. Feed it decoded text chunks. */
export function createSseParser(onMessage: (m: SseMessage) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0 || event) onMessage({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };

  const handleLine = (line: string) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let m: RegExpExecArray | null;
      while ((m = /\r\n|\n|\r/.exec(buffer))) {
        // A lone trailing \r may be the first half of \r\n; wait for more input.
        if (m[0] === '\r' && m.index === buffer.length - 1) break;
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        handleLine(line);
      }
    },
    flush() {
      if (buffer) handleLine(buffer);
      buffer = '';
      dispatch();
    },
  };
}

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onDone: (usage: unknown) => void;
  onTool?: (tool: string, status: 'running' | 'completed') => void;
  onError: (message: string) => void;
}

export const HERMES_UNREACHABLE = 'Hermes unreachable — check Settings';

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** POST /api/chat and parse the SSE response stream. Never throws; reports through handlers. */
export async function streamChat(
  cfg: WorkbenchConfig,
  body: ChatRequest,
  handlers: ChatHandlers,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
): Promise<void> {
  let finished = false;
  const finish = (fn: () => void) => {
    if (!finished) {
      finished = true;
      fn();
    }
  };
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      let msg = `Chat failed (HTTP ${res.status})`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) msg = j.error.message;
      } catch {
        /* ignore */
      }
      return finish(() => handlers.onError(msg));
    }
    const parser = createSseParser((m) => {
      const payload = safeJson(m.data) as Record<string, unknown> | undefined;
      if (m.event === 'delta') {
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (text) handlers.onDelta(text);
      } else if (m.event === 'tool') {
        const tool = typeof payload?.tool === 'string' ? payload.tool : '';
        const status = payload?.status === 'completed' ? 'completed' : 'running';
        if (tool) handlers.onTool?.(tool, status);
      } else if (m.event === 'done') {
        finish(() => handlers.onDone(payload?.usage ?? payload));
      } else if (m.event === 'error') {
        const msg = typeof payload?.message === 'string' ? payload.message : m.data || 'Unknown error';
        finish(() => handlers.onError(msg));
      }
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.flush();
    finish(() => handlers.onDone(undefined));
  } catch (e) {
    if (signal?.aborted) return;
    finish(() => handlers.onError(e instanceof TypeError ? HERMES_UNREACHABLE : String(e)));
  }
}

export type ConnectionStatus = 'connecting' | 'open' | 'lost';

export interface EventsOptions {
  cfg: WorkbenchConfig;
  onEvent: (e: WorkbenchEvent) => void;
  onStatus: (s: ConnectionStatus) => void;
  EventSourceImpl?: typeof EventSource;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Subscribe to /api/events with reconnect + exponential backoff. Returns a disposer. */
export function connectEvents(opts: EventsOptions): () => void {
  const { cfg, onEvent, onStatus } = opts;
  const ES = opts.EventSourceImpl ?? EventSource;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 10_000;
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const handle = (name: string | undefined) => (ev: MessageEvent) => {
    const parsed = safeJson(String(ev.data)) as Record<string, unknown> | undefined;
    let type = name;
    let payload: unknown = parsed;
    if (parsed && typeof parsed.type === 'string' && 'payload' in parsed) {
      type = parsed.type;
      payload = parsed.payload;
    }
    if (type && (EVENT_TYPES as string[]).includes(type)) {
      onEvent({ type: type as WorkbenchEventType, payload });
    }
  };

  const open = () => {
    if (disposed) return;
    onStatus('connecting');
    const q = cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : '';
    es = new ES(`${cfg.baseUrl}/api/events${q}`);
    es.onopen = () => {
      attempt = 0;
      onStatus('open');
    };
    es.onmessage = handle(undefined);
    for (const t of EVENT_TYPES) es.addEventListener(t, handle(t) as EventListener);
    es.onerror = () => {
      es?.close();
      es = null;
      if (disposed) return;
      onStatus('lost');
      const delay = Math.min(max, base * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  };
  open();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
