import { useState } from 'react';
import { parseJsonish, type JournalEntry } from '../../lib/types';
import { timeAgo } from '../../lib/format';

export function isUndoable(e: JournalEntry): boolean {
  return e.inverse_json != null && e.tool !== 'undo' && !e.undone_at;
}

export function UndoButton({ entry, onUndo }: { entry: JournalEntry; onUndo: (id: string) => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entry.undone_at) {
    return (
      <button className="btn small" disabled>
        Undone
      </button>
    );
  }
  if (!isUndoable(entry)) return null;
  return (
    <>
      <button
        className="btn small"
        disabled={busy}
        data-testid="undo-btn"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onUndo(entry.id);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Undo failed');
          } finally {
            setBusy(false);
          }
        }}
      >
        Undo
      </button>
      {error && (
        <span className="inline-error" role="alert">
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
