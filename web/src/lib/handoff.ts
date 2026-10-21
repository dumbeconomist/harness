import type { UiAction } from './commands';

const KEY = 'workbench.handoff';
const MAX_AGE_MS = 60_000;

/** The quick bar hands an action to the main window through localStorage (shared by both windows). */
export function postHandoff(action: UiAction): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ action, at: Date.now() }));
  } catch {
    /* storage unavailable: the main window just opens */
  }
}

export function consumeHandoff(now = Date.now()): UiAction | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const v = JSON.parse(raw) as { action?: UiAction; at?: number };
    if (!v.action || typeof v.at !== 'number' || now - v.at > MAX_AGE_MS) return null;
    return v.action;
  } catch {
    return null;
  }
}

export const HANDOFF_KEY = KEY;
