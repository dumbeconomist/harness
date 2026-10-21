import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import type { Doctor, DoctorCheck } from '../../lib/types';

export function firstProblem(d: Doctor | null): DoctorCheck | null {
  if (!d || d.ok) return null;
  return d.checks.find((c) => c.status === 'fail' && c.blocking) ?? d.checks.find((c) => c.status === 'fail') ?? null;
}

const LABEL: Record<DoctorCheck['status'], string> = { ok: 'OK', warn: 'Warning', fail: 'Failed', skip: 'Skipped' };

const ISO_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/;

/** Renders `backticked` text as <code> and ISO timestamps as relative times with the ISO string as a tooltip. */
export function RichText({ text, now = Date.now() }: { text: string; now?: number }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
        return part.split(ISO_RE).map((seg, j) =>
          j % 2 === 1 ? (
            <time key={`${i}-${j}`} dateTime={seg} title={seg}>
              {relativeTime(seg, now)}
            </time>
          ) : (
            <span key={`${i}-${j}`}>{seg}</span>
          ),
        );
      })}
    </>
  );
}

/**
 * Sidebar status item, directly above "Commands". The slot always reserves its height, so it appearing or
 * disappearing never reflows anything, and it never overlaps the approval card. Opens Settings → Connection doctor.
 */
export function DoctorStatus({ doctor, onOpen }: { doctor: Doctor | null; onOpen: () => void }) {
  const bad = firstProblem(doctor);
  return (
    <div className="doctor-slot">
      {bad && (
        <button
          className="nav-item doctor-status"
          data-testid="doctor-status"
          title={`${bad.title}: ${bad.message}${bad.fix ? `\n${bad.fix}` : ''}`.replace(/`/g, '')}
          onClick={onOpen}
        >
          <span aria-hidden>⚠</span>
          <span className="doctor-status-text">
            Connection: {bad.title}
          </span>
        </button>
      )}
    </div>
  );
}

export function DoctorPanel({
  api,
  refreshKey = 0,
  onResult,
}: {
  api: Pick<Api, 'doctor'>;
  refreshKey?: number;
  onResult?: (d: Doctor) => void;
}) {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [busy, setBusy] = useState<'run' | 'deep' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const run = useCallback(
    async (deep: boolean) => {
      setBusy(deep ? 'deep' : 'run');
      setError(null);
      try {
        const d = await api.doctor(deep);
        setDoctor(d);
        onResultRef.current?.(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  useEffect(() => {
    void run(false);
  }, [run, refreshKey]);

  return (
    <div className="card" data-testid="doctor-panel">
      <div className="row between">
        <strong data-testid="doctor-summary">
          {busy ? 'Checking…' : doctor ? (doctor.ok ? 'Connection looks good' : 'Connection needs attention') : 'Not run yet'}
        </strong>
        <span className="row gap">
          <button className="btn small" disabled={busy !== null} onClick={() => void run(false)} data-testid="doctor-run">
            Run
          </button>
          <button
            className="btn small"
            disabled={busy !== null}
            onClick={() => void run(true)}
            title="Also sends a 1-token request to Hermes to prove the model responds"
            data-testid="doctor-run-deep"
          >
            Run deep
          </button>
        </span>
      </div>
      {error && (
        <p className="inline-error" role="alert" data-testid="doctor-error">
          Could not run the doctor: {error}
        </p>
      )}
      {doctor?.checked_at && (
        <div className="muted" data-testid="doctor-checked-at">
          Checked <time dateTime={doctor.checked_at} title={doctor.checked_at}>{relativeTime(doctor.checked_at)}</time>
        </div>
      )}
      {doctor && (
        <ul className="doctor-list">
          {doctor.checks.map((c) => (
            <li key={c.id} data-testid={`doctor-check-${c.id}`} data-status={c.status}>
              <span className={`pill ${c.status}`}>{LABEL[c.status]}</span>
              <span className="doctor-title">{c.title}</span>
              <div className="muted"><RichText text={c.message} /></div>
              {c.detail && (
                <details className="doctor-detail" data-testid={`doctor-detail-${c.id}`}>
                  <summary>Details</summary>
                  <pre>{c.detail}</pre>
                </details>
              )}
              {c.fix && c.status !== 'ok' && c.status !== 'skip' && (
                <div className="doctor-fix" data-testid={`doctor-fix-${c.id}`}>
                  <RichText text={c.fix} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
