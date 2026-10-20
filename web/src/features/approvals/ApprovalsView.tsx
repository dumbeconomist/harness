import { useState } from 'react';
import type { Approval, Task } from '../../lib/types';
import { timeAgo } from '../../lib/format';
import { ApprovalDetail, tierLabel } from './ApprovalCard';

interface Props {
  approvals: Approval[];
  tasks?: Task[];
  onDecide: (id: string, decision: 'approve' | 'deny') => void | Promise<void>;
}

function Row({ a, tasks, onDecide }: { a: Approval; tasks: Task[]; onDecide: Props['onDecide'] }) {
  const tier2 = a.tier >= 2;
  const [reviewed, setReviewed] = useState(!tier2);
  return (
    <li className="card" data-testid="approval-row">
      <div className="row between">
        <span>
          <code>{a.tool}</code> <span className={`badge tier-${tier2 ? 2 : 1}`}>{tierLabel(a.tier)}</span>
        </span>
        <span className="muted">{timeAgo(a.created_at)}</span>
      </div>
      <p>{a.summary}</p>
      {reviewed && <ApprovalDetail approval={a} tasks={tasks} />}
      <div className="row end gap">
        <button className="btn danger" onClick={() => void onDecide(a.id, 'deny')}>
          Deny
        </button>
        {reviewed ? (
          <button className="btn primary" onClick={() => void onDecide(a.id, 'approve')}>
            Approve
          </button>
        ) : (
          <button className="btn primary" onClick={() => setReviewed(true)}>
            Review
          </button>
        )}
      </div>
    </li>
  );
}

export function ApprovalsView({ approvals, tasks = [], onDecide }: Props) {
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
            <Row key={a.id} a={a} tasks={tasks} onDecide={onDecide} />
          ))}
        </ul>
      )}
    </section>
  );
}
