import { useEffect, useState } from 'react';
import { api as defaultApi, type Api } from '../../lib/api';
import {
  KNOWN_TOOLS,
  PERMISSION_KEYS,
  type Health,
  type Permissions,
  type PermissionKey,
  type Policies,
  type PolicyValue,
} from '../../lib/types';

export const PERMISSION_INFO: Record<PermissionKey, { label: string; desc: string }> = {
  web: { label: 'Web access', desc: 'Let Hermes browse and fetch pages on your behalf.' },
  files: { label: 'Files', desc: 'Let Hermes read and write files on this Mac.' },
  mail: { label: 'Mail', desc: 'Let Hermes read your inbox and draft or send messages.' },
  terminal: { label: 'Terminal', desc: 'Let Hermes run shell commands.' },
  calendar: { label: 'Calendar', desc: 'Let Hermes read and create calendar events.' },
  code: { label: 'Code', desc: 'Let Hermes edit and run code in your projects.' },
};

const EMPTY_PERMS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Permissions;

interface Props {
  api?: Api;
  health: Health | null;
  onRefreshHealth?: () => void;
}

export function SettingsView({ api = defaultApi, health, onRefreshHealth }: Props) {
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [policies, setPolicies] = useState<Policies>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.getPermissions(), api.getPolicies()])
      .then(([p, pol]) => {
        if (!live) return;
        setPerms({ ...EMPTY_PERMS, ...p });
        setPolicies(pol);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api]);

  const togglePerm = async (k: PermissionKey, v: boolean) => {
    if (!perms) return;
    const prev = perms;
    setPerms({ ...perms, [k]: v });
    try {
      setPerms({ ...EMPTY_PERMS, ...(await api.putPermissions({ ...perms, [k]: v })) });
      setError(null);
    } catch (e) {
      setPerms(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setPolicy = async (tool: string, v: PolicyValue) => {
    const prev = policies;
    const next = { ...policies, [tool]: v };
    setPolicies(next);
    try {
      setPolicies(await api.putPolicies(next));
      setError(null);
    } catch (e) {
      setPolicies(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="view" aria-label="Settings">
      <header className="view-head">
        <h1>Settings</h1>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      <h2 className="group-title">Hermes connection</h2>
      <div className="card row between" data-testid="hermes-status">
        <span>
          <span className={`dot ${health ? (health.hermes.reachable ? 'done' : 'blocked') : 'blocked'}`} aria-hidden />{' '}
          {health === null
            ? 'Workbench core unreachable'
            : health.hermes.reachable
              ? 'Hermes is reachable'
              : 'Hermes is not reachable — check that the Hermes API server is running'}
          {health && <span className="muted"> · core v{health.version}</span>}
        </span>
        <button className="btn small" onClick={onRefreshHealth}>
          Check again
        </button>
      </div>

      <h2 className="group-title">Permissions</h2>
      <p className="muted">Everything Hermes can reach beyond tasks is off until you turn it on.</p>
      <ul className="cards">
        {PERMISSION_KEYS.map((k) => (
          <li key={k} className="card row between">
            <label htmlFor={`perm-${k}`}>
              <strong>{PERMISSION_INFO[k].label}</strong>
              <div className="muted">{PERMISSION_INFO[k].desc}</div>
            </label>
            <input
              id={`perm-${k}`}
              type="checkbox"
              role="switch"
              className="switch"
              checked={perms?.[k] ?? false}
              disabled={!perms}
              onChange={(e) => void togglePerm(k, e.target.checked)}
            />
          </li>
        ))}
      </ul>

      <h2 className="group-title">Tool policy</h2>
      <p className="muted">“Ask” shows an approval card each time. Destructive and external tools always ask.</p>
      <ul className="cards">
        {KNOWN_TOOLS.map((t) => {
          const locked = t.tier >= 2;
          const value: PolicyValue = locked ? 'ask' : (policies[t.name] ?? 'ask');
          return (
            <li key={t.name} className="card row between">
              <label htmlFor={`pol-${t.name}`}>
                <code>{t.name}</code> <span className={`badge tier-${locked ? 2 : 1}`}>Tier {t.tier}</span>
                <div className="muted">{t.description}</div>
              </label>
              <span className="row gap">
                <select
                  id={`pol-${t.name}`}
                  value={value}
                  disabled={locked}
                  title={locked ? 'Tier 2 tools always require approval' : undefined}
                  onChange={(e) => void setPolicy(t.name, e.target.value as PolicyValue)}
                >
                  <option value="ask">{locked ? 'Always ask' : 'Ask'}</option>
                  {!locked && <option value="auto">Auto-approve</option>}
                </select>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
