import type { APIRequestContext } from '@playwright/test';

export const CORE = `http://127.0.0.1:${process.env.E2E_CORE_PORT ?? '8765'}`;
export const AUTH = { Authorization: 'Bearer e2e-token' };

let rpcId = 1;

/** Fire an MCP JSON-RPC tools/call. Returns the in-flight promise (it blocks until a human decides). */
export function callTool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  return request.post(`${CORE}/mcp`, {
    headers: { ...AUTH, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } },
    timeout: 45_000,
  });
}

export function toolText(body: { result?: { content?: { text: string }[] } }): string {
  return body.result?.content?.[0]?.text ?? '';
}
