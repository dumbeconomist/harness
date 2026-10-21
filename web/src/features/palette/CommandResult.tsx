import { useEffect, useRef, useState } from 'react';
import { streamChat } from '../../lib/sse';
import { UNDO_ARM_MS, describeEntry, type CommandCtx, type CommandResult } from '../../lib/commands';
import { timeAgo } from '../../lib/format';
import type { JournalEntry } from '../../lib/types';

/** Streams an answer from Hermes. Ephemeral: no thread, nothing is persisted except the ledger entry. */
export function AskResult({ question, ctx, onOpenInWorkbench }: { question: string; ctx: CommandCtx; onOpenInWorkbench?: (q: string) => void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'streaming' | 'done' | 'error'>('streaming');
  const [error, setError] = useState('');
  const cfg = ctx.api.config;
  useEffect(() => {
    const ac = new AbortController();
    setText('');
    setState('streaming');
    void streamChat(
      cfg,
      { messages: [{ role: 'user', content: question }] },
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
    return () => ac.abort();
  }, [cfg, question]);
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
      {onOpenInWorkbench && (
        <div className="qr-actions">
          <button className="btn small" onClick={() => onOpenInWorkbench(question)} data-testid="open-in-workbench">
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
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
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
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
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
      {state !== 'done' && (
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
  onOpenInWorkbench?: (q: string) => void;
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
