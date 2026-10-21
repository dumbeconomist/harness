import { useEffect, useRef, useState } from 'react';
import { streamChat } from '../../lib/sse';
import { ApiError } from '../../lib/api';
import { UNDO_ARM_MS, ensureQuickThread, describeEntry, type CommandCtx, type CommandResult } from '../../lib/commands';
import { timeAgo } from '../../lib/format';
import type { JournalEntry } from '../../lib/types';

export interface OpenInfo {
  question: string;
  /** The real general thread the ask ran in (Q&A already persisted there), when one could be created. */
  threadId?: string;
}

/**
 * Streams an answer from Hermes inside the shared "Quick questions" general thread (looked up or created first, thread_id sent), so
 * "Open in Workbench" can show that exact thread with the Q&A already in it. No re-send.
 */
export function AskResult({ question, ctx, onOpenInWorkbench }: { question: string; ctx: CommandCtx; onOpenInWorkbench?: (i: OpenInfo) => void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'streaming' | 'done' | 'error'>('streaming');
  const [error, setError] = useState('');
  const [threadId, setThreadId] = useState<string | undefined>();
  const cfg = ctx.api.config;
  const createThread = ctx.api.createThread;
  const listThreads = ctx.api.listThreads;
  useEffect(() => {
    const ac = new AbortController();
    setText('');
    setState('streaming');
    setThreadId(undefined);
    void (async () => {
      let tid: string | undefined;
      try {
        tid = await ensureQuickThread({ listThreads, createThread });
      } catch {
        tid = undefined; // core without threads: the answer still streams, just not persisted
      }
      if (ac.signal.aborted) return;
      setThreadId(tid);
      await streamChat(
        cfg,
        { messages: [{ role: 'user', content: question }], ...(tid ? { thread_id: tid } : {}) },
        {
          onDelta: (t) => setText((s) => s + t),
          onDone: () => setState('done'),
          onError: (m) => {
            setError(m);
            setState('error');
          },
        },
        ac.signal,
      );
    })();
    return () => ac.abort();
  }, [cfg, createThread, listThreads, question]);
  return (
    <div className="qr qr-ask" data-testid="ask-result">
      <div className="qr-q muted">{question}</div>
      <div className="qr-answer" data-testid="ask-answer" aria-live="polite">
        {text || (state === 'streaming' ? <span className="typing">Thinking…</span> : null)}
      </div>
      {state === 'error' && (
        <div className="msg-error" role="alert">
          {error}
        </div>
      )}
      {onOpenInWorkbench && state === 'done' && (
        <div className="qr-actions">
          <button className="btn small" onClick={() => onOpenInWorkbench({ question, threadId })} data-testid="open-in-workbench">
            Open in Workbench
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Shows the entry that /undo would revert. The Confirm button does not exist until UNDO_ARM_MS after the
 * entry is shown, never takes focus on its own, and ignores key auto-repeat.
 */
export function UndoResult({ entry, ctx, onDone }: { entry: JournalEntry | null; ctx: CommandCtx; onDone?: () => void }) {
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error' | 'stale'>('idle');
  const [msg, setMsg] = useState('');
  const busy = useRef(false);
  const id = entry?.id;
  useEffect(() => {
    setArmed(false);
    setState('idle');
    if (!id) return;
    const t = window.setTimeout(() => setArmed(true), UNDO_ARM_MS);
    return () => window.clearTimeout(t);
  }, [id]);
  if (!entry) {
    return (
      <div className="qr" data-testid="undo-result">
        Nothing to undo.
      </div>
    );
  }
  const confirm = async () => {
    if (!armed || busy.current || !id) return;
    busy.current = true;
    setState('busy');
    try {
      await ctx.api.undo(id);
      setState('done');
      setMsg(`Undone: ${describeEntry(entry)}`);
      onDone?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setState('stale'); // changed since: no Confirm, friendly text, no raw ids
      } else {
        setState('error');
        setMsg(e instanceof Error ? e.message : String(e));
      }
    } finally {
      busy.current = false;
    }
  };
  return (
    <div className="qr" data-testid="undo-result">
      <div>
        Undo <strong data-testid="undo-target">{describeEntry(entry)}</strong>{' '}
        <span className="muted">{timeAgo(entry.ts)}</span>?
      </div>
      {state === 'done' && (
        <div className="qr-ok" role="status" data-testid="undo-done">
          {msg}
        </div>
      )}
      {state === 'error' && (
        <div className="msg-error" role="alert">
          {msg}
        </div>
      )}
      {state === 'stale' && (
        <div className="msg-error" role="alert" data-testid="undo-stale">
          This changed after that action, so undo the newer change first.{' '}
          <button className="link" onClick={() => ctx.ui({ type: 'goto', view: 'journal' })}>
            Open Activity
          </button>
        </div>
      )}
      {state !== 'done' && state !== 'stale' && (
        <div className="qr-actions">
          {armed ? (
            <button
              className="btn danger"
              data-testid="undo-confirm-cmd"
              disabled={state === 'busy'}
              onKeyDown={(e) => {
                if (e.repeat) e.preventDefault();
              }}
              onClick={() => void confirm()}
            >
              {state === 'busy' ? 'Undoing…' : 'Confirm undo'}
            </button>
          ) : (
            <span className="muted" data-testid="undo-arming">
              Confirm appears in a moment…
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultView({
  result,
  ctx,
  onOpenInWorkbench,
}: {
  result: CommandResult;
  ctx: CommandCtx;
  onOpenInWorkbench?: (i: OpenInfo) => void;
}) {
  switch (result.kind) {
    case 'none':
      return null;
    case 'done':
      return (
        <div className="qr qr-ok" role="status" data-testid="cmd-done">
          {result.message}
        </div>
      );
    case 'error':
      return (
        <div className="qr msg-error" role="alert" data-testid="cmd-error">
          {result.message}
        </div>
      );
    case 'ask':
      return <AskResult key={result.question} question={result.question} ctx={ctx} onOpenInWorkbench={onOpenInWorkbench} />;
    case 'undo':
      return <UndoResult key={result.entry?.id ?? 'none'} entry={result.entry} ctx={ctx} />;
    case 'status':
      return (
        <div className="qr" data-testid="status-result">
          <strong>{result.doctor.ok ? 'Everything needed is working' : 'Something needs attention'}</strong>
          <ul className="doctor-list compact">
            {result.doctor.checks.map((c) => (
              <li key={c.id} data-status={c.status}>
                <span className={`pill ${c.status}`}>{c.status}</span> {c.title}
                {c.status !== 'ok' && c.status !== 'skip' && <div className="muted">{c.fix ?? c.message}</div>}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'find':
      return (
        <div className="qr" data-testid="find-result">
          {result.tasks.length === 0 ? (
            <span className="muted">No tasks match “{result.query}”.</span>
          ) : (
            <ul className="qr-list">
              {result.tasks.map((t) => (
                <li key={t.id}>
                  <button className="link" onClick={() => ctx.ui({ type: 'open-task', id: t.id })}>
                    {t.title}
                  </button>{' '}
                  <span className="muted">{t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
  }
}
