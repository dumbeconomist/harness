import { useEffect, useRef, useState } from 'react';
import { parseJsonish, type Approval } from '../../lib/types';

export function tierLabel(tier: number): string {
  return tier >= 2 ? 'Destructive / external' : 'Change';
}

export function argsPreview(a: Approval['args_json'], max = 400): string {
  const obj = parseJsonish(a);
  const s = obj ? JSON.stringify(obj, null, 2) : typeof a === 'string' ? a : '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface CardProps {
  approval: Approval;
  pendingCount: number;
  onDecide: (decision: 'approve' | 'deny', note?: string) => void | Promise<void>;
}

/**
 * Floating, non-modal approval card. ⌘/Ctrl+Enter approves, Esc denies — handled at window level
 * so the user never has to find focus first.
 */
export function ApprovalCard({ approval, pendingCount, onDecide }: CardProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const busyRef = useRef(false);

  const decide = async (decision: 'approve' | 'deny') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, noteRef.current.trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void decideRef.current('approve');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void decideRef.current('deny');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const preview = argsPreview(approval.args_json);
  return (
    <aside className={`approval-card tier-${approval.tier >= 2 ? 2 : 1}`} role="alertdialog" aria-label="Approval needed" data-testid="approval-card">
      <div className="ac-head">
        <span className="ac-kicker">Approval needed</span>
        <span className={`badge tier-${approval.tier >= 2 ? 2 : 1}`} data-testid="tier-badge">
          Tier {approval.tier} · {tierLabel(approval.tier)}
        </span>
      </div>
      <div className="ac-tool">
        <code>{approval.tool}</code>
        <span className="muted"> requested by {approval.requested_by || 'agent'}</span>
      </div>
      <p className="ac-summary">{approval.summary}</p>
      {preview && <pre className="ac-args">{preview}</pre>}
      <input
        className="ac-note"
        aria-label="Note (optional)"
        placeholder="Add a note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          // typing in the note must not trigger Esc→deny by accident; Esc just blurs
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="ac-actions">
        <button className="btn danger" onClick={() => void decide('deny')} disabled={busy} data-testid="deny-btn">
          Deny <kbd>⎋</kbd>
        </button>
        <button className="btn primary" onClick={() => void decide('approve')} disabled={busy} data-testid="approve-btn" autoFocus>
          Approve <kbd>⌘↵</kbd>
        </button>
      </div>
      {pendingCount > 1 && <div className="ac-more muted">+{pendingCount - 1} more waiting</div>}
    </aside>
  );
}
