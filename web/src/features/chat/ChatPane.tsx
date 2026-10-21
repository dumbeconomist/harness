import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkbenchConfig } from '../../lib/config';
import { timeAgo } from '../../lib/format';
import { streamChat, type ToolStatus } from '../../lib/sse';
import { displayToolName, parseJsonish, type ChatContext, type Thread, type ThreadMessage } from '../../lib/types';
import type { Api } from '../../lib/api';

export interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  error?: string;
  streaming?: boolean;
  /** Persisted user turn that never reached Hermes. */
  notSent?: boolean;
  /** Persisted assistant reply cut off part-way. */
  interrupted?: boolean;
  tools?: { name: string; status: ToolStatus }[];
}

interface Props {
  api: Pick<Api, 'listThreads' | 'createThread' | 'threadMessages'>;
  cfg: WorkbenchConfig;
  context: ChatContext | null;
  contextLabel: string;
  hidden: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
  slot?: ReactNode;
}

let nextId = 1;
const NO_MESSAGES: Msg[] = [];
const NEW_THREAD = '__new__';

/** Threads are per context: a task id, or "general". */
export function contextOf(context: ChatContext | null): { kind: string; id: string; key: string } {
  return context ? { kind: context.kind, id: context.id, key: `${context.kind}:${context.id}` } : { kind: 'general', id: 'general', key: 'general:general' };
}

function toolChip(r: ThreadMessage): { name: string; status: ToolStatus } {
  const j = parseJsonish(r.tool_json);
  const name = typeof j?.tool === 'string' ? j.tool : typeof j?.name === 'string' ? j.name : r.content || 'tool';
  const st = j?.status;
  return { name, status: st === 'running' || st === 'completed' || st === 'failed' ? st : 'completed' };
}

/** Persisted rows (oldest first) → chat messages; tool rows become chips on the assistant reply they belong to. */
export function threadToMsgs(rows: ThreadMessage[]): Msg[] {
  const out: Msg[] = [];
  let tools: { name: string; status: ToolStatus }[] = [];
  const flushToLastAssistant = () => {
    const last = out[out.length - 1];
    if (tools.length && last && last.role === 'assistant') last.tools = [...(last.tools ?? []), ...tools];
    tools = [];
  };
  for (const r of rows) {
    if (r.role === 'tool') tools.push(toolChip(r));
    else if (r.role === 'assistant') {
      out.push({ id: nextId++, role: 'assistant', content: r.content, ...(tools.length ? { tools } : {}), ...(r.status === 'partial' ? { interrupted: true } : {}) });
      tools = [];
    } else {
      flushToLastAssistant();
      out.push({ id: nextId++, role: 'user', content: r.content, ...(r.status === 'failed' ? { notSent: true } : {}) });
    }
  }
  flushToLastAssistant();
  return out;
}

/** Most recently updated first (core also sorts; this keeps local bumps in order). */
export function sortThreads(list: Thread[]): Thread[] {
  return [...list].sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at));
}

export function ChatPane({ api, cfg, context, contextLabel, hidden, onOpenSettings, onClose, slot }: Props) {
  const ctx = contextOf(context);
  const key = ctx.key;
  const [threads, setThreads] = useState<Record<string, Thread[]>>({});
  /** undefined = threads not loaded yet, null = a new (not yet created) thread, string = thread id */
  const [active, setActive] = useState<Record<string, string | null>>({});
  const [chats, setChats] = useState<Record<string, Msg[]>>({});
  const [draft, setDraft] = useState('');
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const aborts = useRef<Record<string, AbortController>>({});
  const requested = useRef<Set<string>>(new Set());
  const apiRef = useRef(api);
  apiRef.current = api;
  const activeId = active[key];
  const current = activeId ? chats[activeId] : undefined;
  const messages = current ?? NO_MESSAGES;
  const busy = !!busyKeys[key];
  const threadList = threads[key] ?? [];

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    const prefill = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text === 'string' && text) setDraft(text);
      focus();
    };
    // Show a specific general thread (e.g. an ask from the quick bar) with its persisted Q&A. Never re-sends.
    const openThread = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== 'string' || !id) return;
      const gk = 'general:general';
      requested.current.delete(`msgs:${id}`);
      requested.current.delete(`threads:${gk}`);
      setChats((c) => {
        const rest = { ...c };
        delete rest[id];
        return rest;
      });
      setActive((a) => ({ ...a, [gk]: id }));
      apiRef.current
        .listThreads('general', 'general')
        .then((list) => setThreads((t) => ({ ...t, [gk]: sortThreads(list) })))
        .catch(() => undefined);
    };
    window.addEventListener('workbench:open-thread', openThread);
    window.addEventListener('workbench:focus-chat', focus);
    window.addEventListener('workbench:prefill-chat', prefill);
    const ctl = aborts.current;
    return () => {
      window.removeEventListener('workbench:open-thread', openThread);
      window.removeEventListener('workbench:focus-chat', focus);
      window.removeEventListener('workbench:prefill-chat', prefill);
      Object.values(ctl).forEach((a) => a.abort());
    };
  }, []);

  // Load this context's threads; open the newest one.
  useEffect(() => {
    const reqKey = `threads:${key}`;
    if (requested.current.has(reqKey)) return;
    requested.current.add(reqKey);
    let live = true;
    api
      .listThreads(ctx.kind, ctx.id)
      .then((list) => {
        if (!live) return;
        setThreads((t) => {
          const have = t[key] ?? [];
          const extra = have.filter((h) => !list.some((l) => l.id === h.id)); // created while this was loading
          return { ...t, [key]: sortThreads([...extra, ...list]) };
        });
        setActive((a) => (a[key] === undefined ? { ...a, [key]: sortThreads(list)[0]?.id ?? null } : a));
      })
      .catch(() => {
        requested.current.delete(reqKey);
        if (!live) return;
        setThreads((t) => ({ ...t, [key]: [] }));
        setActive((a) => (a[key] === undefined ? { ...a, [key]: null } : a));
      });
    return () => {
      live = false;
    };
  }, [api, key, ctx.kind, ctx.id]);

  // Load the active thread's history once (cached afterwards so in-flight streams are not clobbered).
  useEffect(() => {
    const id = activeId;
    if (!id || id.startsWith('local:') || chats[id] !== undefined) return;
    const reqKey = `msgs:${id}`;
    if (requested.current.has(reqKey)) return;
    requested.current.add(reqKey);
    api
      .threadMessages(id)
      .then((rows) => setChats((c) => (c[id] !== undefined ? c : { ...c, [id]: threadToMsgs(rows) })))
      .catch((e) => {
        requested.current.delete(reqKey);
        setNotice(`Could not load this thread: ${e instanceof Error ? e.message : String(e)}`);
      });
  }, [api, activeId, chats]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current]);

  const patchLast = useCallback((tid: string, fn: (m: Msg) => Msg) => {
    setChats((c) => {
      const list = c[tid] ?? [];
      if (list.length === 0) return c;
      return { ...c, [tid]: [...list.slice(0, -1), fn(list[list.length - 1]!)] };
    });
  }, []);

  const newThread = () => {
    setActive((a) => ({ ...a, [key]: null }));
    setNotice(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const send = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text || busy) return;
    const k = key;
    const c = ctx;
    const chatCtx = context;
    setNotice(null);
    setBusyKeys((b) => ({ ...b, [k]: true }));
    let tid = active[k] ?? null;
    let persisted = !!tid && !tid.startsWith('local:');
    if (!tid) {
      try {
        const t = await api.createThread({ context_kind: c.kind, context_id: c.id, title: text.slice(0, 60) });
        tid = t.id;
        persisted = true;
        setThreads((all) => ({ ...all, [k]: sortThreads([t, ...(all[k] ?? [])]) }));
        setChats((all) => ({ ...all, [t.id]: [] }));
      } catch {
        tid = `local:${k}`; // core without threads: keep the old in-memory behaviour
        persisted = false;
      }
      const created = tid;
      setActive((a) => ({ ...a, [k]: created }));
    }
    const threadId = tid;
    const history = persisted
      ? []
      : (chats[threadId] ?? [])
          .filter((m) => !m.error && m.content)
          .map((m) => ({ role: m.role, content: m.content }));
    if (override === undefined) setDraft('');
    setChats((all) => ({
      ...all,
      [threadId]: [
        ...(all[threadId] ?? []),
        { id: nextId++, role: 'user', content: text },
        { id: nextId++, role: 'assistant', content: '', streaming: true },
      ],
    }));
    if (persisted) {
      const stamp = new Date().toISOString();
      setThreads((all) => ({ ...all, [k]: sortThreads((all[k] ?? []).map((t) => (t.id === threadId ? { ...t, updated_at: stamp } : t))) }));
    }
    const ac = new AbortController();
    aborts.current[k] = ac;
    await streamChat(
      cfg,
      {
        messages: [...history, { role: 'user', content: text }],
        ...(chatCtx ? { context: chatCtx } : {}),
        ...(persisted ? { thread_id: threadId } : {}),
      },
      {
        onDelta: (t) => patchLast(threadId, (m) => ({ ...m, content: m.content + t })),
        onTool: (tool, status) =>
          patchLast(threadId, (m) => {
            const tools = [...(m.tools ?? [])];
            const i = tools.findIndex((t) => t.name === tool && t.status === 'running');
            if (i >= 0 && status !== 'running') tools[i] = { name: tool, status };
            else tools.push({ name: tool, status });
            return { ...m, tools };
          }),
        onDone: () => patchLast(threadId, (m) => ({ ...m, streaming: false })),
        onError: (message) => patchLast(threadId, (m) => ({ ...m, streaming: false, error: message })),
      },
      ac.signal,
    );
    delete aborts.current[k];
    setBusyKeys((b) => ({ ...b, [k]: false }));
  };

  return (
    <aside className="chat" hidden={hidden} aria-label="Hermes">
      <header className="chat-head">
        <div>
          <strong>Hermes</strong>
          <div className="muted chat-ctx" data-testid="chat-context">
            {context ? `About: ${contextLabel}` : 'General — select a task to focus'}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Hide Hermes pane" title="Hide (⌘J)">
          ✕
        </button>
      </header>
      <div className="thread-bar" data-testid="thread-switcher">
        <select
          aria-label="Thread"
          value={activeId ?? NEW_THREAD}
          onChange={(e) => {
            if (e.target.value === NEW_THREAD) newThread();
            else {
              setActive((a) => ({ ...a, [key]: e.target.value }));
              setNotice(null);
            }
          }}
        >
          {(activeId === null || activeId === undefined || activeId.startsWith('local:')) && <option value={activeId ?? NEW_THREAD}>New thread</option>}
          {threadList.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || 'Untitled'} · {timeAgo(t.updated_at || t.created_at)}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={newThread} disabled={activeId === null} data-testid="new-thread">
          New thread
        </button>
      </div>
      {notice && (
        <p className="inline-error" role="alert">
          {notice}
        </p>
      )}
      <div className="chat-log" ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 && !slot && (
          <div className="state empty">
            <strong>{context ? 'Ask about this task' : 'Ask Hermes anything'}</strong>
            <p>Hermes can propose changes — you approve each one before it happens.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
            {m.tools && m.tools.length > 0 && (
              <div className="chips">
                {m.tools.map((t, i) => (
                  <span key={i} className={`chip ${t.status}`} data-testid="tool-chip">
                    {t.status === 'running' ? (
                      <span className="spinner" aria-label="running" />
                    ) : t.status === 'completed' ? (
                      <span aria-label="completed">✓</span>
                    ) : t.status === 'failed' ? (
                      <span aria-label="failed">✕</span>
                    ) : (
                      <span aria-label="activity">•</span>
                    )}{' '}
                    {displayToolName(t.name)}
                  </span>
                ))}
              </div>
            )}
            {m.notSent && (
              <div className="msg-note" data-testid="not-sent">
                not sent –{' '}
                <button className="link" disabled={busy} onClick={() => void send(m.content)}>
                  retry
                </button>
              </div>
            )}
            {m.content || (m.streaming && !m.error ? <span className="typing">Thinking…</span> : null)}
            {m.interrupted && (
              <div className="msg-note muted" data-testid="interrupted">
                (interrupted)
              </div>
            )}
            {m.error && (
              <div className="msg-error" role="alert">
                {m.error}{' '}
                <button className="link" onClick={onOpenSettings}>
                  Open Settings
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {slot && <div className="chat-slot">{slot}</div>}
      <div className="chat-input">
        <textarea
          ref={inputRef}
          aria-label="Message Hermes"
          placeholder={context ? 'Ask Hermes about this task…' : 'Message Hermes…'}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" onClick={() => void send()} disabled={busy || !draft.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </aside>
  );
}
