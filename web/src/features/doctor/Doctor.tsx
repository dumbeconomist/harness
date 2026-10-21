import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../../lib/api';
import type { Doctor, DoctorCheck } from '../../lib/types';

export function firstProblem(d: Doctor | null): DoctorCheck | null {
  if (!d || d.ok) return null;
  return d.checks.find((c) => c.status === 'fail' && c.blocking) ?? d.checks.find((c) => c.status === 'fail') ?? null;
}

const LABEL: Record<DoctorCheck['status'], string> = { ok: 'OK', warn: 'Warning', fail: 'Failed', skip: 'Skipped' };

/** App-wide strip shown while the doctor reports `ok: false`. Floats (no layout shift); dismissable for the session. */
export function DoctorBanner({ doctor, onFix }: { doctor: Doctor | null; onFix: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const bad = firstProblem(doctor);
  useEffect(() => {
    if (!bad) setDismissed(false); // healthy again: next failure shows the banner afresh
  }, [bad]);
  if (!bad || dismissed) return null;
  return (
    <div className="doctor-banner" role="status" data-testid="doctor-banner">
      <div className="doctor-banner-text">
        <strong>{bad.title}:</strong> {bad.message}
        {bad.fix && <div className="doctor-fix">{bad.fix}</div>}
      </div>
      <button className="btn small" onClick={onFix}>
        Open Settings
      </button>
      <button className="icon-btn" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        ✕
      </button>
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
      {doctor && (
        <ul className="doctor-list">
          {doctor.checks.map((c) => (
            <li key={c.id} data-testid={`doctor-check-${c.id}`} data-status={c.status}>
              <span className={`pill ${c.status}`}>{LABEL[c.status]}</span>
              <span className="doctor-title">{c.title}</span>
              <div className="muted">{c.message}</div>
              {c.fix && c.status !== 'ok' && c.status !== 'skip' && (
                <div className="doctor-fix" data-testid={`doctor-fix-${c.id}`}>
                  {c.fix}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
