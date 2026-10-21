/**
 * Moving focus to the approval card is only ever done on an explicit user action (palette "Review pending
 * approval", ⌘⇧A, the quick bar's "approvals waiting" link). The card ignores events without `explicit`.
 */
export const FOCUS_APPROVAL_EVENT = 'workbench:focus-approval';

export function requestFocusApproval(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_APPROVAL_EVENT, { detail: { explicit: true } }));
}

export function isExplicitFocusRequest(e: Event): boolean {
  return (e as CustomEvent<{ explicit?: boolean } | null>).detail?.explicit === true;
}

/** Automatic activation (notification follow-up): highlight only, focus never moves. */
export function pulseApproval(ms = 2000): void {
  const el = document.documentElement;
  el.setAttribute('data-approval-pulse', '');
  window.setTimeout(() => el.removeAttribute('data-approval-pulse'), ms);
}
