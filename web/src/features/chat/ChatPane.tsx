import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkbenchConfig } from '../../lib/config';
import { streamChat, type ToolStatus } from '../../lib/sse';
import { displayToolName, type ChatContext } from '../../lib/types';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  error?: string;
  streaming?: boolean;
  tools?: { name: string; status: ToolStatus }[];
}

interface Props {
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

export function ChatPane({ cfg, context, contextLabel, hidden, onOpenSettings, onClose, slot }: Props) {
  const key = context ? `${context.kind}:${context.id}` : 'general';
  const [chats, setChats] = useState<Record<string, Msg[]>>({});
  const [draft, setDraft] = useState('');
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const aborts = useRef<Record<string, AbortController>>({});
  const sessions = useRef<Record<string, string>>({});
  const current = chats[key];
  const messages = current ?? NO_MESSAGES;
  const busy = !!busyKeys[key];

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener('workbench:focus-chat', focus);
    const ctl = aborts.current;
    return () => {
      window.removeEventListener('workbench:focus-chat', focus);
      Object.values(ctl).forEach((a) => a.abort());
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current]);

  const patchLast = useCallback((k: string, fn: (m: Msg) => Msg) => {
    setChats((c) => {
      const list = c[k] ?? [];
      if (list.length === 0) return c;
      return { ...c, [k]: [...list.slice(0, -1), fn(list[list.length - 1]!)] };
    });
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const k = key;
    const ctx = context;
    const history = (chats[k] ?? [])
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    setDraft('');
    setChats((c) => ({
      ...c,
      [k]: [
        ...(c[k] ?? []),
        { id: nextId++, role: 'user', content: text },
        { id: nextId++, role: 'assistant', content: '', streaming: true },
      ],
    }));
    setBusyKeys((b) => ({ ...b, [k]: true }));
    const sessionId = (sessions.current[k] ??= crypto.randomUUID());
    const ac = new AbortController();
    aborts.current[k] = ac;
    await streamChat(
      cfg,
      { messages: [...history, { role: 'user', content: text }], ...(ctx ? { context: ctx } : {}), session_id: sessionId },
      {
        onDelta: (t) => patchLast(k, (m) => ({ ...m, content: m.content + t })),
        onTool: (tool, status) =>
          patchLast(k, (m) => {
            const tools = [...(m.tools ?? [])];
            const i = tools.findIndex((t) => t.name === tool && t.status === 'running');
            if (i >= 0 && status !== 'running') tools[i] = { name: tool, status };
            else tools.push({ name: tool, status });
            return { ...m, tools };
          }),
        onDone: () => patchLast(k, (m) => ({ ...m, streaming: false })),
        onError: (message) => patchLast(k, (m) => ({ ...m, streaming: false, error: message })),
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
      <div className="chat-log" ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 && (
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
            {m.content || (m.streaming && !m.error ? <span className="typing">Thinking…</span> : null)}
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
