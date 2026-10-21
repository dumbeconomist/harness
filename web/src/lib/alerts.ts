import { useEffect, useRef } from 'react';
import type { Approval } from './types';
import type { NativeBridge } from './native';

/** How long after a notification a window activation may focus the approval card. */
export const NOTIFY_FOCUS_WINDOW_MS = 2 * 60_000;
/** Do not move focus if the user typed in an input this recently. */
export const TYPING_GRACE_MS = 1000;

export interface AlertDeps {
  now: () => number;
  isBackground: () => boolean;
  native: () => NativeBridge | undefined;
  browserNotify: (title: string, body: string, approvalId: string, onClick: () => void) => void;
  /** Dispatch `workbench:focus-approval` (focuses the card container only; never a button). */
  focusApproval: () => void;
}

/**
 * Notification + badge logic. Notifications carry no actions; the only follow-up is focusing the
 * approval card (existing, focus-only behaviour). Nothing here can decide an approval.
 */
export function createApprovalAlerts(deps: AlertDeps) {
  const seen = new Set<string>();
  const notified = new Map<string, number>();
  let pending = new Set<string>();
  let badge = -1;
  let lastTypedAt = -Infinity;

  return {
    noteTyping() {
      lastTypedAt = deps.now();
    },
    /** Call whenever the pending approvals list changes. */
    sync(approvals: Approval[]) {
      pending = new Set(approvals.map((a) => a.id));
      for (const id of [...notified.keys()]) if (!pending.has(id)) notified.delete(id); // handled: clear marker
      for (const id of [...seen]) if (!pending.has(id)) seen.delete(id);
      if (approvals.length !== badge) {
        badge = approvals.length;
        try {
          void deps.native()?.setBadge(badge);
        } catch {
          /* shell gone */
        }
      }
      for (const a of approvals) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (!deps.isBackground()) continue;
        const title = a.tier >= 2 ? 'Approval needed (destructive)' : 'Approval needed';
        const body = a.summary || a.tool;
        const native = deps.native();
        if (native) {
          try {
            void native.notify(title, body, a.id);
            notified.set(a.id, deps.now());
          } catch {
            /* ignore */
          }
        } else {
          deps.browserNotify(title, body, a.id, () => {
            notified.delete(a.id);
            deps.focusApproval();
          });
        }
      }
    },
    /** The main window gained focus / became visible. */
    onActivate() {
      const now = deps.now();
      let hit = false;
      for (const [id, at] of [...notified]) {
        if (now - at > NOTIFY_FOCUS_WINDOW_MS) notified.delete(id);
        else if (pending.has(id)) hit = true;
      }
      if (!hit) return;
      if (now - lastTypedAt < TYPING_GRACE_MS) return; // never steal focus mid-typing
      notified.clear(); // once
      deps.focusApproval();
    },
    _notifiedCount: () => notified.size,
  };
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

/** Wires the tracker to the DOM and keeps it fed with the pending approvals. Main window only. */
export function useApprovalAlerts(approvals: Approval[]) {
  const ref = useRef<ReturnType<typeof createApprovalAlerts> | null>(null);
  if (!ref.current) {
    ref.current = createApprovalAlerts({
      now: () => Date.now(),
      isBackground: () => document.visibilityState === 'hidden' || !document.hasFocus(),
      native: () => window.__WORKBENCH_NATIVE__,
      browserNotify: (title, body, id, onClick) => {
        try {
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
          const n = new Notification(title, { body, tag: id });
          n.onclick = () => {
            window.focus();
            onClick();
          };
        } catch {
          /* ignore */
        }
      },
      focusApproval: () => window.dispatchEvent(new Event('workbench:focus-approval')),
    });
  }
  const alerts = ref.current;

  useEffect(() => {
    const typed = (e: Event) => isEditable(e.target) && alerts.noteTyping();
    const activate = () => {
      if (document.visibilityState === 'visible') alerts.onActivate();
    };
    document.addEventListener('keydown', typed, true);
    document.addEventListener('input', typed, true);
    window.addEventListener('focus', activate);
    document.addEventListener('visibilitychange', activate);
    return () => {
      document.removeEventListener('keydown', typed, true);
      document.removeEventListener('input', typed, true);
      window.removeEventListener('focus', activate);
      document.removeEventListener('visibilitychange', activate);
    };
  }, [alerts]);

  useEffect(() => {
    alerts.sync(approvals);
  }, [alerts, approvals]);
}
