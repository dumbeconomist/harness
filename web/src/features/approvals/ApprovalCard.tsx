import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parseJsonish, type Approval, type Task } from '../../lib/types';

export function tierLabel(tier: number): string {
  return tier >= 2 ? 'Destructive / external' : 'Change';
}

/** Full, untruncated, pretty-printed arguments. */
export function argsFull(a: Approval['args_json']): string {
  const obj = parseJsonish(a);
  return obj ? JSON.stringify(obj, null, 2) : typeof a === 'string' ? a : '';
}

interface Change {
  field: string;
  from: string;
  to: string;
}

/** For tasks_update: old → new for each field that actually changes, using the task from the store. */
export function computeChanges(approval: Approval, tasks: Task[]): { target: Task | null; changes: Change[] } {
  const args = parseJsonish(approval.args_json);
  const id = typeof args?.id === 'string' ? args.id : null;
  const target = id ? (tasks.find((t) => t.id === id) ?? null) : null;
  const changes: Change[] = [];
  if (approval.tool === 'tasks_update' && args && target) {
    for (const f of ['title', 'notes', 'status'] as const) {
      const v = args[f];
      if (typeof v === 'string' && v !== target[f]) changes.push({ field: f, from: target[f], to: v });
    }
  }
  return { target, changes };
}

export function ApprovalDetail({ approval, tasks }: { approval: Approval; tasks: Task[] }) {
  const { target, changes } = computeChanges(approval, tasks);
  return (
    <>
      {approval.tool === 'tasks_delete' && target && (
        <div className="ac-diff" data-testid="ac-target">
          Will delete task <strong>{target.title}</strong>
          {target.notes && <div className="muted">Notes: {target.notes}</div>}
        </div>
      )}
      {changes.length > 0 && (
        <ul className="ac-diff" data-testid="ac-changes">
          {changes.map((c) => (
            <li key={c.field}>
              <span className="muted">{c.field}:</span> <del>{c.from || '(empty)'}</del> → <ins>{c.to || '(empty)'}</ins>
            </li>
          ))}
        </ul>
      )}
      <details className="ac-details" open>
        <summary>Full arguments</summary>
        <pre className="ac-args" data-testid="ac-args">
          {argsFull(approval.args_json)}
        </pre>
      </details>
    </>
  );
}

/** Returns [ready, rearm]. `ready` is false for `ms` after mount and after every rearm(). */
export function useArm(ms: number): [boolean, () => void] {
  const [epoch, setEpoch] = useState(0);
  const [ready, setReady] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    setReady(false);
    const t = window.setTimeout(() => setReady(true), ms);
    return () => window.clearTimeout(t);
  }, [ms, epoch]);
  return [ready, () => setEpoch((e) => e + 1)];
}

interface CardProps {
  docked?: boolean;
  approval: Approval;
  pendingCount: number;
  tasks?: Task[];
  /** Ignore decisions this long after mount (accidental-keystroke guard). */
  guardMs?: number;
  onDecide: (decision: 'approve' | 'deny', note?: string) => void | Promise<void>;
}

/**
 * Floating, non-modal approval card.
 * Safety rules: never takes focus; keyboard acts only when focus is inside the card; repeat events
 * and anything within guardMs of mount are ignored; Esc collapses (never denies); tier 2 needs an
 * explicit "Review" expand before it can be approved.
 */
export function ApprovalCard({ docked = false, approval, pendingCount, tasks = [], guardMs = 600, onDecide }: CardProps) {
  const tier2 = approval.tier >= 2;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [reviewed, setReviewed] = useState(!tier2);
  const mountedAt = useRef(Date.now());
  const busyRef = useRef(false);
  const rootRef = useRef<HTMLElement>(null);
  // Buttons render disabled until the guard elapses (and again after Review): visibly inert, not silently dropped.
  const [ready, rearm] = useArm(guardMs);

  useEffect(() => {
    mountedAt.current = Date.now();
    const focus = () => {
      setCollapsed(false);
      window.setTimeout(() => rootRef.current?.focus(), 0);
    };
    window.addEventListener('workbench:focus-approval', focus);
    return () => {
      window.removeEventListener('workbench:focus-approval', focus);
    };
  }, []);

  const guarded = () => Date.now() - mountedAt.current < guardMs;

  const review = () => {
    setReviewed(true);
    mountedAt.current = Date.now(); // re-arm: Approve is inert for guardMs after Review
    rearm();
    window.setTimeout(() => rootRef.current?.focus(), 0); // never leave focus on a button that becomes Approve
  };

  const decide = async (decision: 'approve' | 'deny') => {
    if (busyRef.current || guarded()) return;
    if (decision === 'approve' && !reviewed) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, note.trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setCollapsed(true);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.repeat || guarded()) return;
      void decide('approve');
    }
  };

  if (collapsed) {
    return (
      <button className={`approval-badge tier-${tier2 ? 2 : 1}${docked ? ' docked' : ''}`} data-testid="approval-badge" onClick={() => setCollapsed(false)}>
        {pendingCount} approval{pendingCount === 1 ? '' : 's'} waiting — Review
      </button>
    );
  }

  return (
    <aside
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`approval-card tier-${tier2 ? 2 : 1}${docked ? ' docked' : ''}`}
      role="group"
      aria-label="Approval needed"
      data-testid="approval-card"
    >
      <div className="ac-head">
        <span className="ac-kicker">Approval needed</span>
        <span className={`badge tier-${tier2 ? 2 : 1}`} data-testid="tier-badge">
          Tier {approval.tier} · {tierLabel(approval.tier)}
        </span>
        <button className="icon-btn" aria-label="Collapse approval" title="Collapse (Esc)" onClick={() => setCollapsed(true)}>
          –
        </button>
      </div>
      <div className="ac-tool">
        <code>{approval.tool}</code>
        <span className="muted"> requested by {approval.requested_by || 'agent'}</span>
      </div>
      <p className="ac-summary">{approval.summary}</p>
      {reviewed ? (
        <ApprovalDetail approval={approval} tasks={tasks} />
      ) : (
        <p className="muted">This is a destructive action. Review the details before you can approve it.</p>
      )}
      {reviewed && (
        <input
          className="ac-note"
          aria-label="Note (optional)"
          placeholder="Add a note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="ac-actions">
        <button className="btn danger" onClick={() => void decide('deny')} disabled={busy || !ready} data-testid="deny-btn">
          Deny
        </button>
        {reviewed ? (
          <button
            key="approve"
            className="btn primary"
            onClick={(e) => {
              if (tier2 && e.detail === 0) return; // keyboard activation can't approve tier 2
              void decide('approve');
            }}
            disabled={busy || !ready}
            data-testid="approve-btn"
          >
            Approve <kbd>⌘↵</kbd>
          </button>
        ) : (
          <button key="review" className="btn primary" onClick={review} data-testid="review-btn">
            Review
          </button>
        )}
      </div>
      <div className="ac-more muted">
        {pendingCount > 1 ? `+${pendingCount - 1} more waiting · ` : ''}Esc collapses · shortcuts work when this card is focused
      </div>
    </aside>
  );
}
