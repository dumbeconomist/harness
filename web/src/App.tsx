import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { CommandPalette, type PaletteAction } from './features/palette/CommandPalette';

type View = 'tasks' | 'approvals' | 'journal' | 'ledger' | 'settings';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'tasks', label: 'Tasks', icon: '☑' },
  { id: 'approvals', label: 'Approvals', icon: '✓' },
  { id: 'journal', label: 'Activity', icon: '≡' },
  { id: 'ledger', label: 'Ledger', icon: '$' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  const data = useWorkbenchData(api);
  const { refresh } = data;
  const [view, setView] = useState<View>('tasks');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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

  const goto = useCallback((v: View) => {
    setView(v);
  }, []);

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
        setView(NAV[Number(e.key) - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const actions: PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [
      {
        id: 'new-task',
        title: 'New task',
        hint: '⌘N',
        keywords: 'add create todo',
        run: () => {
          setView('tasks');
          window.setTimeout(() => window.dispatchEvent(new Event('workbench:focus-quick-add')), 0);
        },
      },
      ...NAV.map((n, i) => ({
        id: `go-${n.id}`,
        title: `Go to ${n.label}`,
        hint: `⌘${i + 1}`,
        run: () => goto(n.id),
      })),
      {
        id: 'toggle-chat',
        title: chatOpen ? 'Hide Hermes pane' : 'Show Hermes pane',
        hint: '⌘J',
        keywords: 'chat ask',
        run: () => setChatOpen((o) => !o),
      },
      {
        id: 'ask-hermes',
        title: 'Ask Hermes…',
        keywords: 'chat message',
        run: () => {
          setChatOpen(true);
          window.setTimeout(() => window.dispatchEvent(new Event('workbench:focus-chat')), 50);
        },
      },
    ];
    if (topApproval) {
      list.push(
        {
          id: 'focus-approval',
          title: 'Review pending approval',
          hint: '⌘⇧A',
          keywords: 'approval card focus',
          run: () => window.setTimeout(() => window.dispatchEvent(new Event('workbench:focus-approval')), 50),
        },
        ...(topApproval.tier >= 2
          ? []
          : [
        {
          id: 'approve-top',
          title: `Approve: ${topApproval.summary || topApproval.tool}`,
          keywords: 'approve top pending yes',
          run: () => void decide(topApproval.id, 'approve').catch((e) => flash(String(e))),
        }]),
        {
          id: 'deny-top',
          title: `Deny: ${topApproval.summary || topApproval.tool}`,
          keywords: 'deny top pending no reject',
          run: () => void decide(topApproval.id, 'deny').catch((e) => flash(String(e))),
        },
      );
    }
    return list;
  }, [goto, chatOpen, topApproval, decide, flash]);

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
          <ApprovalsView approvals={data.approvals} tasks={data.tasks} onDecide={(id, d) => decide(id, d).catch((e) => flash(String(e)))} />
        )}
        {view === 'journal' && (
          <JournalView entries={data.journal} onUndo={undo} onOpenApproval={() => setView('approvals')} />
        )}
        {view === 'ledger' && <LedgerView summary={data.ledger} />}
        {view === 'settings' && <SettingsView api={api} health={data.health} onRefreshHealth={() => void refresh.health()} />}
      </main>

      <ChatPane
        cfg={api.config}
        context={selected ? { kind: 'task', id: selected.id } : null}
        contextLabel={selected?.title ?? ''}
        hidden={!chatOpen}
        onOpenSettings={() => setView('settings')}
        onClose={() => setChatOpen(false)}
      />

      {topApproval && !paletteOpen && (
        <ApprovalCard
          key={topApproval.id}
          approval={topApproval}
          tasks={data.tasks}
          pendingCount={data.approvals.length}
          onDecide={(d, note) => decide(topApproval.id, d, note)}
        />
      )}
      <CommandPalette open={paletteOpen} actions={actions} onClose={() => setPaletteOpen(false)} />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
