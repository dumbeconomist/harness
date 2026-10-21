/** Guarded bridges to the Tauri shell. Everything is a no-op in a plain browser (and in e2e). */
export interface NativeBridge {
  notify(title: string, body: string, approvalId: string): void | Promise<void>;
  setBadge(count: number): void | Promise<void>;
}

declare global {
  interface Window {
    __WORKBENCH_NATIVE__?: NativeBridge;
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  }
}

/** Calls a shell command if (and only if) running inside Tauri. Returns whether it was attempted. */
export function shellInvoke(cmd: 'open_main' | 'hide_quick'): boolean {
  const inv = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__?.invoke : undefined;
  if (typeof inv !== 'function') return false;
  try {
    void Promise.resolve(inv.call(window.__TAURI_INTERNALS__, cmd, {})).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** `workbench:open-main` */
export const openMainWindow = () => shellInvoke('open_main');
/** `workbench:hide-quick` */
export const hideQuickWindow = () => shellInvoke('hide_quick');
