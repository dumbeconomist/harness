import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api';
import { useWorkbenchData } from './lib/store';
import type { TaskStatus } from './lib/types';
import { TasksView } from './features/tasks/TasksView';
import { ApprovalsView } from './features/approvals/ApprovalsView';
import { ApprovalCard } from './features/approvals/ApprovalCard';
import { JournalView } from './features/journal/JournalView';
import { LedgerView } from './features/ledger/LedgerView';
import { SettingsView } from './features/settings/SettingsView';
import { ChatPane } from './features/chat/ChatPane';
import { CommandPalette } from './features/palette/CommandPalette';
import { DoctorBanner } from './features/doctor/Doctor';
import { QuickBar } from './features/quick/QuickBar';
import { type CommandCtx, type UiAction, type View, VIEWS } from './lib/commands';
import { useApprovalAlerts } from './lib/alerts';
import { consumeHandoff, HANDOFF_KEY } from './lib/handoff';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'tasks', label: 'Tasks', icon: '☑' },
  { id: 'approvals', label: 'Approvals', icon: '✓' },
  { id: 'journal', label: 'Activity', icon: '≡' },
  { id: 'ledger', label: 'Ledger', icon: '$' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

/** `#/quick` renders the quick bar only (no sidebar, no approval card); everything else is the app. */
export function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.startsWith('#/quick') ? <QuickBar /> : <App />;
}

export function App() {
  const data = useWorkbenchData(api);
  const { refresh } = data;
  const [view, setView] = useState<View>('tasks');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const selected = data.tasks.find((t) => t.id === selectedId) ?? null;
  const topApproval = data.approvals[0] ?? null;

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 4000);
  }, []);

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'deny', note?: string) => {
      await api.decide(id, decision, note);
      await Promise.all([refresh.approvals(), refresh.tasks(), refresh.journal()]);
    },
    [refresh],
  );

  const createTask = useCallback(
    async (title: string) => {
      const t = await api.createTask({ title });
      await Promise.all([refresh.tasks(), refresh.journal()]);
      setSelectedId(t.id);
    },
    [refresh],
  );

  const setStatus = useCallback(
    async (id: string, status: TaskStatus) => {
      try {
        await api.updateTask(id, { status });
      } catch (e) {
        flash(e instanceof Error ? e.message : 'Update failed');
      }
      await Promise.all([refresh.tasks(), refresh.journal()]);
    },
    [refresh, flash],
  );

  const undo = useCallback(
    async (id: string) => {
      await api.undo(id);
      await Promise.all([refresh.journal(), refresh.tasks()]);
    },
    [refresh],
  );

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useEffect(() => {
    window.addEventListener('workbench:palette', openPalette);
    return () => window.removeEventListener('workbench:palette', openPalette);
  }, [openPalette]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        window.dispatchEvent(new Event('workbench:focus-approval'));
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setChatOpen((o) => !o);
      } else if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault();
        setView('tasks');
        window.setTimeout(() => window.dispatchEvent(new Event('workbench:focus-quick-add')), 0);
      } else if (/^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setView(VIEWS[Number(e.key) - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const uiRef = useRef<(a: UiAction) => void>(() => undefined);
  uiRef.current = (a) => {
    switch (a.type) {
      case 'goto':
        setView(a.view);
        break;
      case 'new-task':
        setView('tasks');
        window.setTimeout(() => window.dispatchEvent(new Event('workbench:focus-quick-add')), 0);
        break;
      case 'toggle-chat':
        setChatOpen((o) => !o);
        break;
      case 'ask-in-chat':
        setChatOpen(true);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('workbench:prefill-chat', { detail: a.text })), 50);
        break;
      case 'focus-approval':
        // Focus only: the card keeps its own guards; nothing is decided from here.
        window.setTimeout(() => window.dispatchEvent(new Event('workbench:focus-approval')), 50);
        break;
      case 'open-task':
        setView('tasks');
        setSelectedId(a.id);
        setChatOpen(true);
        break;
    }
  };

  // Actions handed over by the quick bar (other window via storage, or this tab after navigating).
  useEffect(() => {
    const take = () => {
      const a = consumeHandoff();
      if (a) uiRef.current(a);
    };
    take();
    const onStorage = (e: StorageEvent) => e.key === HANDOFF_KEY && take();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', take);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', take);
    };
  }, []);

  useApprovalAlerts(data.approvals);

  const cmdCtx: CommandCtx = useMemo(
    () => ({
      api,
      ui: (a) => uiRef.current(a),
      pendingApprovals: data.approvals.length,
      surface: 'palette',
    }),
    [data.approvals.length],
  );

  const approvalCard = (docked: boolean) =>
    topApproval && (
      <ApprovalCard
        key={`${topApproval.id}:${docked}`}
        docked={docked}
        approval={topApproval}
        tasks={data.tasks}
        pendingCount={data.approvals.length}
        onDecide={(d, note) => decide(topApproval.id, d, note)}
      />
    );

  return (
    <div className={`app${chatOpen ? '' : ' chat-collapsed'}`}>
      <nav className="sidebar" aria-label="Main">
        <div className="titlebar-drag" />
        <div className="brand">Workbench</div>
        <ul>
          {NAV.map((n, i) => (
            <li key={n.id}>
              <button
                className={`nav-item${view === n.id ? ' active' : ''}`}
                aria-current={view === n.id ? 'page' : undefined}
                onClick={() => setView(n.id)}
              >
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                <span className="nav-label">{n.label}</span>
                {n.id === 'approvals' && data.approvals.length > 0 && (
                  <span className="nav-badge" data-testid="approvals-badge" aria-label={`${data.approvals.length} pending`}>
                    {data.approvals.length}
                  </span>
                )}
                {!(n.id === 'approvals' && data.approvals.length > 0) && <kbd className="nav-kbd">⌘{i + 1}</kbd>}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <button className="nav-item" onClick={openPalette}>
            <span className="nav-icon" aria-hidden>
              ⌘
            </span>
            <span className="nav-label">Commands</span>
            <kbd className="nav-kbd">⌘K</kbd>
          </button>
        </div>
      </nav>

      <DoctorBanner doctor={data.doctor} onFix={() => setView('settings')} />
      <main className="main">
        {data.connection === 'lost' && (
          <div className="banner" role="status" data-testid="connection-banner">
            Connection to Workbench lost — retrying…
          </div>
        )}
        {data.health?.addr_fallback && (
          <div className="banner info" role="status" data-testid="addr-fallback-banner">
            Hermes is configured for :8765 but Workbench is on :{data.health.addr?.split(':').pop() ?? '?'} — update the
            connection in Settings.
          </div>
        )}
        <div className="main-bar">
          <span />
          {!chatOpen && (
            <button className="btn small" onClick={() => setChatOpen(true)} title="Show Hermes (⌘J)">
              Hermes
            </button>
          )}
        </div>
        {view === 'tasks' && (
          <TasksView
            tasks={data.tasks}
            loaded={data.tasksState.loaded}
            error={data.tasksState.error}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              if (id) setChatOpen(true);
            }}
            onCreate={createTask}
            onStatus={setStatus}
            onRetry={() => void refresh.tasks()}
            onUpdate={async (id, patch) => {
              await api.updateTask(id, patch);
              await Promise.all([refresh.tasks(), refresh.journal()]);
            }}
            onDelete={async (id) => {
              await api.deleteTask(id);
              setSelectedId(null);
              await Promise.all([refresh.tasks(), refresh.journal()]);
            }}
          />
        )}
        {view === 'approvals' && (
          <ApprovalsView approvals={data.approvals} tasks={data.tasks} highlightId={highlightId} onDecide={(id, d) => decide(id, d).catch((e) => flash(String(e)))} />
        )}
        {view === 'journal' && (
          <JournalView entries={data.journal} onUndo={undo} onOpenApproval={(id) => {
              if (data.approvals.some((a) => a.id === id)) {
                setHighlightId(id);
                setView('approvals');
              } else flash('That approval has already been decided.');
            }} />
        )}
        {view === 'ledger' && <LedgerView summary={data.ledger} entries={data.ledgerEntries} />}
        {view === 'settings' && <SettingsView
            api={api}
            health={data.health}
            onRefreshHealth={() => {
              void refresh.health();
              void refresh.doctor();
            }}
            onDoctor={refresh.setDoctor}
          />}
      </main>

      <ChatPane
        api={api}
        cfg={api.config}
        context={selected ? { kind: 'task', id: selected.id } : null}
        contextLabel={selected?.title ?? ''}
        hidden={!chatOpen}
        onOpenSettings={() => setView('settings')}
        onClose={() => setChatOpen(false)}
        slot={chatOpen ? approvalCard(true) : null}
      />
      {!chatOpen && approvalCard(false)}

      <CommandPalette open={paletteOpen} ctx={cmdCtx} onClose={() => setPaletteOpen(false)} />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
