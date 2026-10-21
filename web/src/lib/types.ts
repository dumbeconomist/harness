export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  goal_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Approval {
  id: string;
  tool: string;
  tier: number;
  /** JSON string per the DB schema, but tolerate an already-parsed object. */
  args_json: string | Record<string, unknown> | null;
  summary: string;
  status: ApprovalStatus;
  requested_by: string;
  created_at: string;
  decided_at: string | null;
  note: string | null;
}

export interface JournalEntry {
  id: string;
  ts: string;
  actor: 'agent' | 'user';
  tool: string;
  args_json: string | Record<string, unknown> | null;
  result_json: string | Record<string, unknown> | null;
  approval_id: string | null;
  idempotency_key: string | null;
  inverse_json: string | Record<string, unknown> | null;
  undone_at: string | null;
}

export interface LedgerEntry {
  id: string;
  ts: string;
  run_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  source: string;
}

export interface LedgerSummary {
  total_usd: number;
  today_usd?: number;
  last7_usd?: number;
  last30_usd?: number;
  total_tokens?: number;
  unpriced_runs?: number;
  by_model: { model: string; usd: number; tokens: number; priced?: boolean }[];
  by_day: { day: string; usd: number }[];
}

export interface Health {
  ok: boolean;
  version: string;
  hermes: { reachable: boolean };
  addr?: string;
  addr_fallback?: boolean;
}

export interface HermesSettings {
  url: string;
  has_key: boolean;
  key_persisted: boolean;
  reachable: boolean;
  model?: string;
}

export interface ConnectionInfo {
  mcp_url: string;
  mcp_token: string;
  hermes_config_snippet: string;
}

export const PERMISSION_KEYS = ['web', 'files', 'mail', 'terminal', 'calendar', 'code'] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type Permissions = Record<PermissionKey, boolean>;

export type PolicyValue = 'ask' | 'auto';
export type Policies = Record<string, PolicyValue>;

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
export interface ChatContext {
  kind: string;
  id: string;
}
export interface ChatRequest {
  messages: ChatMessage[];
  context?: ChatContext;
  session_id?: string;
  thread_id?: string;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  /** Raw upstream error, shown collapsed under "Details". */
  detail?: string;
  blocking: boolean;
}
export interface Doctor {
  ok: boolean;
  checked_at?: string;
  checks: DoctorCheck[];
}

export interface Thread {
  id: string;
  context_kind: string | null;
  context_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}
export interface ThreadMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_json: string | Record<string, unknown> | null;
  status?: 'ok' | 'failed' | 'partial';
  created_at: string;
}

export type WorkbenchEventType =
  | 'approval.created'
  | 'approval.decided'
  | 'journal.appended'
  | 'journal.undone'
  | 'task.changed'
  | 'ledger.appended';

export const EVENT_TYPES: WorkbenchEventType[] = [
  'approval.created',
  'approval.decided',
  'journal.appended',
  'journal.undone',
  'task.changed',
  'ledger.appended',
];

export interface WorkbenchEvent {
  type: WorkbenchEventType;
  payload: unknown;
}

/** Known tools and their risk tier (mirrors core; tier 2 can never be `auto`). */
export const KNOWN_TOOLS: { name: string; tier: number; description: string }[] = [
  { name: 'tasks_create', tier: 1, description: 'Create a task' },
  { name: 'tasks_update', tier: 1, description: 'Edit or change the status of a task' },
  { name: 'tasks_delete', tier: 2, description: 'Delete a task' },
];

export function parseJsonish(v: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function displayToolName(tool: string): string {
  return tool.replace(/^mcp__workbench__/, '');
}
