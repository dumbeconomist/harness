import { loadConfig, type WorkbenchConfig } from './config';
import type {
  Approval,
  ConnectionInfo,
  Health,
  HermesSettings,
  JournalEntry,
  LedgerEntry,
  LedgerSummary,
  Permissions,
  Policies,
  Task,
  TaskStatus,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createApi(cfg: WorkbenchConfig, fetchImpl: FetchLike = (i, init) => globalThis.fetch(i, init)) {
  const url = (path: string) => `${cfg.baseUrl}${path}`;
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    ...extra,
  });

  async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(url(path), {
        method,
        headers: auth
          ? headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined)
          : body !== undefined
            ? { 'Content-Type': 'application/json' }
            : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : 'Network error', 0, 'network');
    }
    if (!res.ok) {
      let message = res.statusText || `HTTP ${res.status}`;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        if (j.error?.message) message = j.error.message;
        code = j.error?.code;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(message, res.status, code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : '';
  };

  return {
    config: cfg,
    health: () => request<Health>('GET', '/api/health', undefined, false),
    listTasks: (status?: TaskStatus) => request<Task[]>('GET', `/api/tasks${q({ status })}`),
    createTask: (b: { title: string; notes?: string; status?: TaskStatus }) => request<Task>('POST', '/api/tasks', b),
    updateTask: (id: string, patch: Partial<Pick<Task, 'title' | 'notes' | 'status'>>) =>
      request<Task>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch),
    deleteTask: (id: string) => request<void>('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
    listApprovals: (status?: string) => request<Approval[]>('GET', `/api/approvals${q({ status })}`),
    decide: (id: string, decision: 'approve' | 'deny', note?: string) =>
      request<Approval>('POST', `/api/approvals/${encodeURIComponent(id)}/decision`, {
        decision,
        ...(note ? { note } : {}),
      }),
    listJournal: (limit = 50) => request<JournalEntry[]>('GET', `/api/journal${q({ limit })}`),
    undo: (id: string) => request<JournalEntry>('POST', `/api/journal/${encodeURIComponent(id)}/undo`),
    ledgerSummary: () => request<LedgerSummary>('GET', '/api/ledger/summary'),
    ledgerEntries: (limit = 50) => request<LedgerEntry[]>('GET', `/api/ledger/entries${q({ limit })}`),
    getPermissions: () => request<Permissions>('GET', '/api/settings/permissions'),
    putPermissions: (p: Permissions) => request<Permissions>('PUT', '/api/settings/permissions', p),
    getPolicies: () => request<Policies>('GET', '/api/settings/policies'),
    getHermes: () => request<HermesSettings>('GET', '/api/settings/hermes'),
    putHermes: (b: { url?: string; api_key?: string }) => request<HermesSettings>('PUT', '/api/settings/hermes', b),
    getConnection: () => request<ConnectionInfo>('GET', '/api/settings/connection'),
    putPolicies: (p: Policies) => request<Policies>('PUT', '/api/settings/policies', p),
  };
}

export type Api = ReturnType<typeof createApi>;

export const api: Api = createApi(loadConfig());
