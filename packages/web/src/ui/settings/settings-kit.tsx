/** The page frame, tables, confirmations and hub requests every settings page shares. */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { AccessAction, AccessAnswer } from "../../shell/workspace-access.js";
import { Button } from "../shadcn/button.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "../shadcn/alert-dialog.js";

export const CELL = "border-b border-(--border) px-2 py-3 text-left";
export const ROW_HEADER = `${CELL} font-normal wrap-anywhere`;
export const ROW_ACTION = "min-h-8 rounded-(--radius-sm) border-0 bg-transparent px-2 font-[inherit] ub-type-ui text-muted-foreground hover:enabled:bg-accent hover:enabled:text-foreground disabled:opacity-50";

/** A titled page carries `ub-settings-title`; the note keeps its line while its text is unknown. */
export function SettingsPage({ title, note, noteRole, gap, children }: {
  title?: string; note?: string | null | undefined; noteRole?: "status" | "alert"; gap?: "gap-4" | "gap-6"; children: ReactNode;
}): ReactElement {
  const heading = title === undefined ? null : <h1 id="ub-settings-title" className="ub-title">{title}</h1>;
  return <section className="ub-pane ub-page-pane" data-settings-page aria-labelledby={title === undefined ? undefined : "ub-settings-title"}>
    <div className={gap === undefined ? "ub-column" : `ub-column ${gap}`}>
      {note === undefined ? heading : <div className="ub-page-header">
        {heading}
        <p className="m-0 min-h-(--type-small-leading) ub-type-small" role={noteRole}>{note}</p>
      </div>}
      {children}
    </div>
  </section>;
}

/** Column headings; `actions` adds a trailing column whose Actions heading only screen readers announce. */
export function TableHead({ columns, actions = false }: { columns: string[]; actions?: boolean }): ReactElement {
  return <thead><tr>
    {columns.map((column) => <th key={column} className={`${CELL} ub-type-ui`} scope="col">{column}</th>)}
    {actions && <th className={`${CELL} ub-type-ui`} scope="col"><span className="sr-only">Actions</span></th>}
  </tr></thead>;
}

/** A quiet row action that asks first. Red is only for permanent removals. */
export function ConfirmAction({ trigger, label, title, description, action = trigger, variant = "default", disabled, onConfirm }: {
  trigger: string; label: string; title: string; description: string; action?: string;
  variant?: "default" | "destructive"; disabled: boolean; onConfirm: () => void;
}): ReactElement {
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button variant="plain" size="custom" type="button" className={ROW_ACTION} disabled={disabled} aria-label={label}>{trigger}</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={variant} disabled={disabled} onClick={onConfirm}>{action}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export interface Feedback { applied: boolean; text: string }

export function FeedbackLine({ feedback }: { feedback: Feedback | null }): ReactElement | null {
  return feedback === null ? null
    : <p className="m-0 ub-type-ui" role={feedback.applied ? "status" : "alert"}>{feedback.text}</p>;
}

export function hubHost(hub: string | null): string {
  try { return hub === null ? "this hub" : new URL(hub).host; }
  catch { return "this hub"; }
}

/** A request that throws reads as an unreachable hub. */
export async function askHub(send: (action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>,
  action: AccessAction, signal: AbortSignal): Promise<AccessAnswer> {
  try { return await send(action, signal); }
  catch { return { status: "hub-down", hub: null }; }
}

/** The success text when the hub applied the change, even if it could not close every connection. */
export function acknowledged(result: AccessAnswer, success: string): string | null {
  if (result.status === "ok") return success;
  if (result.status === "closure-failed" && result.applied === true) {
    return `${success} The change was applied; the hub could not close every active connection.`;
  }
  return null;
}

/** Refusals of this computer's hub login, with the page's own next step; null for any other status. */
export function loginFailure(status: string, hub: string | null, next: string): string | null {
  switch (status) {
    case "sign-in-required": return `Sign-in is required. Run ub auth login ${hub ?? "<hub>"} on this computer, then ${next}.`;
    case "not-configured": return "This hub has no GitHub sign-in configured. Ask the hub owner to configure GitHub sign-in.";
    case "credential-store":
    case "credential-store-refused":
    case "credential-store-unreadable": return `The login on this computer could not be read. Check your credential store, then ${next}.`;
    case "renewal-unavailable": return `The hub could not renew this computer's login. Reconnect to the hub, then ${next}.`;
    default: return null;
  }
}

const idle = (): void => {};

/**
 * One hub change at a time. `load` runs on mount and whenever it changes, with
 * a new lifetime signal; the previous one aborts, as it does on unmount, so a
 * late answer never writes state. `work` checks the signal after each await.
 */
export function useHubMutation(load: (signal: AbortSignal) => void = idle) {
  const lifetime = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setBusy(false); setFeedback(null);
    load(controller.signal);
    return () => { controller.abort(); lifetime.current = null; };
  }, [load]);
  const run = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (busy || signal === undefined || signal.aborted) return;
    setBusy(true); setFeedback(null);
    await work(signal);
    if (!signal.aborted) setBusy(false);
  };
  return { busy, feedback, setFeedback, run };
}
