import type { Approval } from '../../lib/types';
import { timeAgo } from '../../lib/format';
import { argsPreview, tierLabel } from './ApprovalCard';

interface Props {
  approvals: Approval[];
  onDecide: (id: string, decision: 'approve' | 'deny') => void | Promise<void>;
}

export function ApprovalsView({ approvals, onDecide }: Props) {
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
            <li key={a.id} className="card" data-testid="approval-row">
              <div className="row between">
                <span>
                  <code>{a.tool}</code> <span className={`badge tier-${a.tier >= 2 ? 2 : 1}`}>{tierLabel(a.tier)}</span>
                </span>
                <span className="muted">{timeAgo(a.created_at)}</span>
              </div>
              <p>{a.summary}</p>
              <pre className="ac-args">{argsPreview(a.args_json)}</pre>
              <div className="row end gap">
                <button className="btn danger" onClick={() => void onDecide(a.id, 'deny')}>
                  Deny
                </button>
                <button className="btn primary" onClick={() => void onDecide(a.id, 'approve')}>
                  Approve
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
