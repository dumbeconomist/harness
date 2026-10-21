import { useEffect, useState } from 'react';
import { DoctorPanel } from '../doctor/Doctor';
import { api as defaultApi, type Api } from '../../lib/api';
import {
  KNOWN_TOOLS,
  PERMISSION_KEYS,
  type ConnectionInfo,
  type Doctor,
  type Health,
  type HermesSettings,
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
  onDoctor?: (d: Doctor) => void;
}

function originOf(u: string): string | null {
  try {
    return new URL(u.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
}

export function SettingsView({ api = defaultApi, health, onRefreshHealth, onDoctor }: Props) {
  const [doctorTick, setDoctorTick] = useState(0);
  const [notifPerm, setNotifPerm] = useState<string>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [policies, setPolicies] = useState<Policies>({});
  const [error, setError] = useState<string | null>(null);
  const [hermes, setHermes] = useState<HermesSettings | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionInfo | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getHermes()
      .then((h) => {
        if (!live) return;
        setHermes(h);
        setUrlDraft(h.url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  const saveHermes = async () => {
    setSaving(true);
    setSaved(false);
    try {
      // Core never forwards the old key to a new host: a host change must say what happens to the key.
      const newOrigin = originOf(urlDraft);
      const hostChanged = !!hermes && newOrigin !== null && newOrigin !== originOf(hermes.url);
      const clearOldKey = hostChanged && !keyDraft;
      const h = await api.putHermes({
        url: urlDraft.trim() || undefined,
        ...(keyDraft ? { api_key: keyDraft } : clearOldKey ? { api_key: '' } : {}),
      });
      setKeyNote(clearOldKey && hermes?.has_key ? 'The Hermes host changed, so the saved API key was cleared. Enter the new host’s key if it needs one.' : null);
      setHermes(h);
      setUrlDraft(h.url);
      setKeyDraft('');
      setSaved(true);
      setError(null);
      onRefreshHealth?.();
      setDoctorTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      setHermes(await api.putHermes({ api_key: '' }));
      setKeyDraft('');
      setSaved(true);
      setError(null);
      onRefreshHealth?.();
      setDoctorTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const revealConn = async () => {
    if (!conn) {
      try {
        setConn(await api.getConnection());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setReveal((r) => !r);
  };

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

      <h2 className="group-title">Connection doctor</h2>
      <DoctorPanel api={api} refreshKey={doctorTick} onResult={onDoctor} />

      <h2 className="group-title">Hermes</h2>
      <div className="card" data-testid="hermes-form">
        <label className="field">
          <span>Hermes API URL</span>
          <input aria-label="Hermes URL" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} placeholder="http://127.0.0.1:8643/v1" />
        </label>
        <label className="field">
          <span>API key</span>
          <input
            aria-label="Hermes API key"
            type="password"
            autoComplete="off"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={hermes?.has_key ? '•••••••• (saved — type to replace)' : 'Not set'}
          />
        </label>
        <div className="row between">
          <span className="muted" data-testid="hermes-meta">
            {hermes
              ? `${hermes.reachable ? 'Reachable' : 'Not reachable'} · key ${hermes.has_key ? 'set' : 'not set'}${hermes.model ? ` · model ${hermes.model}` : ''}`
              : 'Loading…'}
            {saved && ' · saved'}
          </span>
          <span className="row gap">
            {hermes?.has_key && (
              <button className="btn" disabled={saving} onClick={() => void clearKey()}>
                Clear key
              </button>
            )}
            <button className="btn primary" disabled={saving} onClick={() => void saveHermes()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </span>
        </div>
        {keyNote && (
          <p className="inline-warn" data-testid="key-cleared-note">
            {keyNote}
          </p>
        )}
        {hermes?.has_key && !hermes.key_persisted && (
          <p className="inline-warn" data-testid="key-not-persisted">
            The API key is held in memory only and will be lost when Workbench quits (no Keychain available).
          </p>
        )}
      </div>

      <h2 className="group-title">Connect Hermes to Workbench</h2>
      <div className="card conn" data-testid="connection-panel">
        <ol>
          <li>Reveal the connection snippet below.</li>
          <li>Paste it into the config of your locked Workbench Hermes profile (its MCP servers section).</li>
          <li>Restart that Hermes profile so it picks up the Workbench tools.</li>
        </ol>
        <div className="row gap">
          <button className="btn small" onClick={() => void revealConn()}>
            {reveal ? 'Hide' : 'Reveal'} snippet
          </button>
          {reveal && conn && (
            <button
              className="btn small"
              onClick={() => {
                void navigator.clipboard?.writeText(conn.hermes_config_snippet).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
        {reveal && conn && (
          <>
            <p className="muted">
              MCP URL: <code>{conn.mcp_url}</code>
            </p>
            <pre data-testid="mcp-snippet">{conn.hermes_config_snippet}</pre>
            <p className="muted">This contains a secret token. Don’t share it.</p>
          </>
        )}
      </div>

      {notifPerm === 'default' && (
        <>
          <h2 className="group-title">Notifications</h2>
          <div className="card row between">
            <span className="muted">Get a desktop notification when Hermes needs approval while Workbench is in the background. Notifications never approve anything.</span>
            <button
              className="btn small"
              onClick={() => void Notification.requestPermission().then((p) => setNotifPerm(p))}
            >
              Enable
            </button>
          </div>
        </>
      )}

      <h2 className="group-title">Permissions</h2>
      <p className="muted">These capabilities don’t exist yet, so they can’t be switched on. Everything beyond tasks stays off.</p>
      <ul className="cards">
        {PERMISSION_KEYS.map((k) => (
          <li key={k} className="card row between">
            <label htmlFor={`perm-${k}`}>
              <strong>{PERMISSION_INFO[k].label}</strong> <span className="badge unpriced">coming in G2–G6</span>
              <div className="muted">{PERMISSION_INFO[k].desc}</div>
            </label>
            <input
              id={`perm-${k}`}
              type="checkbox"
              role="switch"
              className="switch"
              checked={perms?.[k] ?? false}
              disabled
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
