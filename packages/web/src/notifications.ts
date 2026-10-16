/** Shared publication API, including editor controls outside React. */
import { toast } from "sonner";
import type { Action } from "sonner";

export type NoticeSeverity = "success" | "info" | "warning" | "error";
export interface Notice {
  message: string;
  severity: NoticeSeverity;
}

export const TRANSIENT_DURATION = 6_000;

let nextId = 0;
const freshId = (): string => `ub-notice-${++nextId}`;
const transients = new Map<string, { id: string; close: () => void }>();
interface Sticky extends Notice {
  id: string;
  dismissed: boolean;
}
const stickies = new Map<string, Sticky>();

/** A repeated key replaces earlier feedback; Sonner owns each toast's lifetime. */
export function notifyTransient({ key, message, severity, action, onClose }: Notice & {
  key?: string;
  action?: Action;
  /** Release application state retained while the toast offers an action. */
  onClose?: () => void;
}): void {
  const id = freshId();
  let closed = false;
  const forget = (): void => {
    if (closed) return;
    closed = true;
    if (key !== undefined && transients.get(key)?.id === id) transients.delete(key);
    onClose?.();
  };
  if (key !== undefined) {
    const previous = transients.get(key);
    previous?.close();
    transients.set(key, { id, close: forget });
    if (previous !== undefined) toast.dismiss(previous.id);
  }
  toast[severity](message, {
    id, duration: severity === "error" ? Infinity : TRANSIENT_DURATION,
    ...(action === undefined ? {} : { action: {
      ...action,
      onClick: (event) => {
        action.onClick(event);
        if (!event.defaultPrevented) forget();
      },
    } }),
    onDismiss: forget, onAutoClose: forget,
  });
}

/** Dismissal hides a condition; only resolution ends it. */
export function notifySticky({ key, message, severity }: Notice & { key: string }): void {
  const previous = stickies.get(key);
  if (previous?.message === message && previous.severity === severity) return;
  // Never resurrect an exiting Sonner element. Visible updates keep their id;
  // a changed dismissed condition gets a new element even during its exit.
  const id = previous !== undefined && !previous.dismissed ? previous.id : freshId();
  const condition: Sticky = { id, message, severity, dismissed: false };
  stickies.set(key, condition);
  toast[severity](message, {
    id, duration: Infinity,
    onDismiss: () => {
      const current = stickies.get(key);
      if (current?.id === id) current.dismissed = true;
    },
  });
}

/** Safe after dismissal or an earlier resolution. */
export function resolveSticky(key: string): void {
  const condition = stickies.get(key);
  stickies.delete(key);
  if (condition !== undefined) toast.dismiss(condition.id);
}
