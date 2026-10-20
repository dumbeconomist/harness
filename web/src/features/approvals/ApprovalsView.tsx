import { useEffect, useRef, useState } from 'react';
import type { Approval, Task } from '../../lib/types';
import { timeAgo } from '../../lib/format';
import { ApprovalDetail, tierLabel, useArm } from './ApprovalCard';

interface Props {
  approvals: Approval[];
  tasks?: Task[];
  onDecide: (id: string, decision: 'approve' | 'deny') => void | Promise<void>;
  highlightId?: string | null;
  guardMs?: number;
}

function Row({
  a,
  tasks,
  onDecide,
  locked,
  highlight,
  guardMs,
}: {
  a: Approval;
  tasks: Task[];
  onDecide: Props['onDecide'];
  locked: boolean;
  highlight: boolean;
  guardMs: number;
}) {
  const tier2 = a.tier >= 2;
  const [reviewed, setReviewed] = useState(!tier2);
  const [ready, rearm] = useArm(guardMs);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlight]);
  const disabled = locked || !ready;
  return (
    <li ref={ref} tabIndex={-1} className={`card${highlight ? ' highlight' : ''}`} data-testid="approval-row">
      <div className="row between">
        <span>
          <code>{a.tool}</code> <span className={`badge tier-${tier2 ? 2 : 1}`}>{tierLabel(a.tier)}</span>
        </span>
        <span className="muted">{timeAgo(a.created_at)}</span>
      </div>
      <p>{a.summary}</p>
      {reviewed && <ApprovalDetail approval={a} tasks={tasks} />}
      <div className="row end gap">
        <button className="btn danger" disabled={disabled} onClick={() => void onDecide(a.id, 'deny')}>
          Deny
        </button>
        {reviewed ? (
          <button
            key="approve"
            className="btn primary"
            disabled={disabled}
            data-testid="row-approve"
            onClick={(e) => {
              if (tier2 && e.detail === 0) return;
              void onDecide(a.id, 'approve');
            }}
          >
            Approve
          </button>
        ) : (
          <button
            key="review"
            className="btn primary"
            data-testid="row-review"
            disabled={disabled}
            onClick={() => {
              setReviewed(true);
              rearm();
              window.setTimeout(() => ref.current?.focus(), 0);
            }}
          >
            Review
          </button>
        )}
      </div>
    </li>
  );
}

export function ApprovalsView({ approvals, tasks = [], onDecide, highlightId = null, guardMs = 600 }: Props) {
  const [locked, setLocked] = useState(false);
  const decide: Props['onDecide'] = async (id, d) => {
    // after any decision every row is inert briefly so a double-click can't hit the next item
    setLocked(true);
    window.setTimeout(() => setLocked(false), guardMs);
    await onDecide(id, d);
  };
  return (
    <section className="view" aria-label="Approvals">
      <header className="view-head">
        <h1>Approvals</h1>
        <span className="muted">{approvals.length} pending</span>
      </header>
      {approvals.length === 0 ? (
        <div className="state empty">
          <strong>Nothing waiting on you</strong>
          <p>When Hermes wants to change something, it shows up here and as a card in the corner.</p>
        </div>
      ) : (
        <ul className="cards">
          {approvals.map((a) => (
            <Row key={a.id} a={a} tasks={tasks} onDecide={decide} locked={locked} highlight={a.id === highlightId} guardMs={guardMs} />
          ))}
        </ul>
      )}
    </section>
  );
}
