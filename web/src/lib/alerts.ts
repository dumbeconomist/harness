import { useEffect, useRef } from 'react';
import type { Approval } from './types';
import type { NativeBridge } from './native';
import { pulseApproval, requestFocusApproval } from './focusApproval';

/** How long after a notification a window activation may focus the approval card. */
export const NOTIFY_FOCUS_WINDOW_MS = 2 * 60_000;

export interface AlertDeps {
  now: () => number;
  isBackground: () => boolean;
  native: () => NativeBridge | undefined;
  browserNotify: (title: string, body: string, approvalId: string, onClick: () => void) => void;
  /** Visual highlight only (a short pulse on the card/badge). Must never move focus. */
  highlight: () => void;
  /** A real click on a browser notification is an explicit user action: focus the card. */
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

  return {
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
    /** The main window gained focus / became visible: highlight only. */
    onActivate() {
      const now = deps.now();
      let hit = false;
      for (const [id, at] of [...notified]) {
        if (now - at > NOTIFY_FOCUS_WINDOW_MS) notified.delete(id);
        else if (pending.has(id)) hit = true;
      }
      if (!hit) return;
      notified.clear(); // once
      // Never move focus on activation: WebKit restores the composer first, and a focus move here would
      // let ⌘↵ typed for a draft land on the card. A pulse tells the user where to look instead.
      deps.highlight();
    },
    _notifiedCount: () => notified.size,
  };
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
      highlight: () => pulseApproval(),
      focusApproval: () => requestFocusApproval(),
    });
  }
  const alerts = ref.current;

  useEffect(() => {
    const activate = () => {
      if (document.visibilityState === 'visible') alerts.onActivate();
    };
    window.addEventListener('focus', activate);
    document.addEventListener('visibilitychange', activate);
    return () => {
      window.removeEventListener('focus', activate);
      document.removeEventListener('visibilitychange', activate);
    };
  }, [alerts]);

  useEffect(() => {
    alerts.sync(approvals);
  }, [alerts, approvals]);
}
