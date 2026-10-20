import { useCallback, useEffect, useRef, useState } from 'react';
import { api as defaultApi, type Api } from './api';
import { connectEvents, type ConnectionStatus } from './sse';
import type { Approval, Health, JournalEntry, LedgerSummary, Task } from './types';

export interface LoadState {
  loaded: boolean;
  error: string | null;
}

export interface WorkbenchData {
  tasks: Task[];
  approvals: Approval[];
  journal: JournalEntry[];
  ledger: LedgerSummary | null;
  health: Health | null;
  connection: ConnectionStatus;
  tasksState: LoadState;
  refresh: {
    tasks: () => Promise<void>;
    approvals: () => Promise<void>;
    journal: () => Promise<void>;
    ledger: () => Promise<void>;
    health: () => Promise<void>;
    all: () => Promise<void>;
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Owns server state: initial load, live updates via /api/events, refetch on change. */
export function useWorkbenchData(api: Api = defaultApi): WorkbenchData {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [tasksState, setTasksState] = useState<LoadState>({ loaded: false, error: null });

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
      setTasksState({ loaded: true, error: null });
    } catch (e) {
      setTasksState({ loaded: true, error: msg(e) });
    }
  }, [api]);
  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals(await api.listApprovals('pending'));
    } catch {
      /* surfaced via connection banner */
    }
  }, [api]);
  const refreshJournal = useCallback(async () => {
    try {
      setJournal(await api.listJournal(100));
    } catch {
      /* ignore */
    }
  }, [api]);
  const refreshLedger = useCallback(async () => {
    try {
      setLedger(await api.ledgerSummary());
    } catch {
      /* ignore */
    }
  }, [api]);
  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch {
      setHealth(null);
    }
  }, [api]);
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshTasks(), refreshApprovals(), refreshJournal(), refreshLedger(), refreshHealth()]);
  }, [refreshTasks, refreshApprovals, refreshJournal, refreshLedger, refreshHealth]);

  const allRef = useRef(refreshAll);
  allRef.current = refreshAll;

  useEffect(() => {
    let first = true;
    const dispose = connectEvents({
      cfg: api.config,
      onStatus: (s) => {
        setConnection(s);
        // (Re)connected: catch up on anything missed while away.
        if (s === 'open') {
          void allRef.current();
          first = false;
        } else if (s === 'lost' && first) {
          void allRef.current();
          first = false;
        }
      },
      onEvent: (e) => {
        switch (e.type) {
          case 'task.changed':
            void refreshTasks();
            break;
          case 'approval.created':
          case 'approval.decided':
            void refreshApprovals();
            void refreshTasks();
            void refreshJournal();
            break;
          case 'journal.appended':
          case 'journal.undone':
            void refreshJournal();
            void refreshTasks();
            break;
          case 'ledger.appended':
            void refreshLedger();
            break;
        }
      },
    });
    return dispose;
  }, [api, refreshTasks, refreshApprovals, refreshJournal, refreshLedger]);

  return {
    tasks,
    approvals,
    journal,
    ledger,
    health,
    connection,
    tasksState,
    refresh: {
      tasks: refreshTasks,
      approvals: refreshApprovals,
      journal: refreshJournal,
      ledger: refreshLedger,
      health: refreshHealth,
      all: refreshAll,
    },
  };
}
