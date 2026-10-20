import type { APIRequestContext } from '@playwright/test';

export const CORE = `http://127.0.0.1:${process.env.E2E_CORE_PORT ?? '8765'}`;
export const UI_AUTH = { Authorization: 'Bearer e2e-token' };
export const MCP_AUTH = { Authorization: 'Bearer e2e-mcp-token' };

let rpcId = 1;

/** Fire an MCP JSON-RPC tools/call (mcp token). Returns the in-flight promise; it blocks until a human decides. */
export function callTool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  return request.post(`${CORE}/mcp`, {
    headers: { ...MCP_AUTH, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } },
    timeout: 45_000,
  });
}

export function toolText(body: { result?: { content?: { text: string }[] } }): string {
  return body.result?.content?.[0]?.text ?? '';
}

export async function pendingApprovals(request: APIRequestContext): Promise<{ id: string; tool: string }[]> {
  const r = await request.get(`${CORE}/api/approvals?status=pending`, { headers: UI_AUTH });
  return r.json();
}

/** Create a task directly through the UI API (actor=user, no approval). */
export async function createTask(request: APIRequestContext, title: string): Promise<{ id: string; title: string }> {
  const r = await request.post(`${CORE}/api/tasks`, { headers: UI_AUTH, data: { title } });
  return r.json();
}

export async function listTaskTitles(request: APIRequestContext): Promise<string[]> {
  const r = await request.get(`${CORE}/api/tasks`, { headers: UI_AUTH });
  return ((await r.json()) as { title: string }[]).map((t) => t.title);
}

/** Deny everything pending through the UI API so blocked MCP calls complete. */
export async function denyAll(request: APIRequestContext): Promise<void> {
  for (const a of await pendingApprovals(request)) {
    await request.post(`${CORE}/api/approvals/${a.id}/decision`, { headers: UI_AUTH, data: { decision: 'deny', note: 'cleanup' } });
  }
}
