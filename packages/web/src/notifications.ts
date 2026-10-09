/** Shared publication API, including editor controls outside React. */
import { toast } from "sonner";

export type NoticeSeverity = "success" | "info" | "warning" | "error";
export interface Notice {
  message: string;
  severity: NoticeSeverity;
}

const labels: Record<NoticeSeverity, string> = {
  success: "Success", info: "Information", warning: "Warning", error: "Error",
};
export const TRANSIENT_DURATION = 10_000;

let nextId = 0;
const freshId = (): string => `ub-notice-${++nextId}`;
const transients = new Map<string, string>();
interface Sticky extends Notice {
  id: string;
  dismissed: boolean;
}
const stickies = new Map<string, Sticky>();

/** A repeated key is a fresh addition, with a fresh native Sonner timer. */
export function notifyTransient({ key, message, severity }: Notice & { key?: string }): void {
  const id = freshId();
  if (key !== undefined) {
    const previous = transients.get(key);
    transients.set(key, id);
    if (previous !== undefined) toast.dismiss(previous);
  }
  const forget = (): void => {
    if (key !== undefined && transients.get(key) === id) transients.delete(key);
  };
  toast[severity](labels[severity], {
    id, description: message, duration: TRANSIENT_DURATION,
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
  toast[severity](labels[severity], {
    id, description: message, duration: Infinity,
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
