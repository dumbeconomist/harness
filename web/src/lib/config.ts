export interface WorkbenchConfig {
  baseUrl: string;
  token: string;
}

declare global {
  interface Window {
    __WORKBENCH__?: Partial<WorkbenchConfig>;
  }
}

export function loadConfig(): WorkbenchConfig {
  const injected = typeof window !== 'undefined' ? window.__WORKBENCH__ : undefined;
  const baseUrl = injected?.baseUrl ?? import.meta.env.VITE_WORKBENCH_URL ?? 'http://127.0.0.1:8765';
  const token = injected?.token ?? import.meta.env.VITE_WORKBENCH_TOKEN ?? '';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}
