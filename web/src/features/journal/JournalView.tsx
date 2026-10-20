import { useState } from 'react';
import { parseJsonish, type JournalEntry } from '../../lib/types';
import { timeAgo } from '../../lib/format';

export function isUndoable(e: JournalEntry): boolean {
  return e.inverse_json != null && e.tool !== 'undo' && !e.undone_at;
}

export function describeUndo(e: JournalEntry): string {
  const inv = parseJsonish(e.inverse_json);
  const task = inv && typeof inv.task === 'object' && inv.task ? (inv.task as Record<string, unknown>) : null;
  const name = task && typeof task.title === 'string' ? `“${task.title}”` : 'the task';
  switch (inv?.op) {
    case 'delete':
      return 'This will delete the task that this action created.';
    case 'restore':
      return `This will restore ${name} to how it was before this change (title, notes, status).`;
    case 'recreate':
      return `This will bring back the deleted task ${name}.`;
    default:
      return 'This will revert this change.';
  }
}

export function UndoButton({ entry, onUndo }: { entry: JournalEntry; onUndo: (id: string) => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entry.undone_at) {
    return (
      <button className="btn small" disabled>
        Undone
      </button>
    );
  }
  if (!isUndoable(entry)) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onUndo(entry.id);
      setConfirming(false);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const m = e instanceof Error ? e.message : 'Undo failed';
      setError(code === 'stale' ? `Can’t undo — this changed afterwards. ${m}` : m);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {confirming ? (
        <span className="undo-confirm" data-testid="undo-confirm-box">
          <span className="muted">{describeUndo(entry)}</span>
          <button className="btn small primary" disabled={busy} onClick={() => void run()} data-testid="undo-confirm">
            Confirm undo
          </button>
          <button className="btn small" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          className="btn small"
          data-testid="undo-btn"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Undo
        </button>
      )}
      {error && (
        <span className="inline-error" role="alert" data-testid="undo-error">
          {error}
        </span>
      )}
    </>
  );
}

function describe(e: JournalEntry): string {
  const args = parseJsonish(e.args_json);
  const title = args && typeof args.title === 'string' ? args.title : null;
  const result = parseJsonish(e.result_json);
  const rtitle = result && typeof result.title === 'string' ? result.title : null;
  return title ?? rtitle ?? '';
}

interface Props {
  entries: JournalEntry[];
  onUndo: (id: string) => Promise<void> | void;
  onOpenApproval?: (approvalId: string) => void;
}

export function JournalView({ entries, onUndo, onOpenApproval }: Props) {
  return (
    <section className="view" aria-label="Activity">
      <header className="view-head">
        <h1>Activity</h1>
        <span className="muted">Everything Hermes and you changed</span>
      </header>
      {entries.length === 0 ? (
        <div className="state empty">
          <strong>No activity yet</strong>
          <p>Changes made by you or approved for Hermes are recorded here, and can be undone.</p>
        </div>
      ) : (
        <ul className="feed">
          {entries.map((e) => (
            <li key={e.id} className={`feed-row${e.undone_at ? ' undone' : ''}`} data-testid="journal-entry">
              <span className={`actor ${e.actor}`}>{e.actor === 'agent' ? 'Hermes' : 'You'}</span>
              <span className="feed-main">
                <code>{e.tool}</code>
                {describe(e) && <span className="feed-detail"> {describe(e)}</span>}
                {e.approval_id && (
                  <button className="link" onClick={() => onOpenApproval?.(e.approval_id!)}>
                    approved
                  </button>
                )}
                {e.undone_at && <span className="muted"> · undone</span>}
              </span>
              <span className="muted feed-time" title={e.ts}>
                {timeAgo(e.ts)}
              </span>
              <UndoButton entry={e} onUndo={onUndo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
