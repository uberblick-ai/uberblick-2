/** Hub-private inventory and administrator removal, with live signed requests. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { AccessAnswer, HubAdmin, HubWorkspace } from "../shell/workspace-access.js";
import type { HubAdministration } from "./hub-administration.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "./shadcn/alert-dialog.js";
import { formatExactTimestamp, formatTimestamp, useTimestampClock } from "./timestamps.js";

const CELL = "border-b border-(--border) px-2 py-3 text-left text-sm";
const SECONDARY_CELL = `${CELL} hidden sm:table-cell`;

function failure(status: string): string {
  switch (status) {
    case "forbidden": return "The hub refused access. Ask a hub administrator for the access you need.";
    case "self-admin": return "You cannot remove yourself as a hub administrator.";
    case "last-admin": return "The hub refused this change: the last hub administrator cannot be removed.";
    case "admin-not-found": return "That account is no longer a hub administrator. Visit Admins again to read the current list.";
    case "sign-in-required": return "Sign in to this workspace's hub with ub auth login, then visit this page again.";
    case "local-only": return "Hub administration is available only from a workspace bound to that hub.";
    case "protocol-mismatch":
    case "update-required": return "Update ub and the hub, restart ub open, then visit this page again.";
    default: return "The hub cannot be reached. Reconnect, then visit this page again.";
  }
}

function host(hub: string | null): string {
  try { return hub === null ? "this hub" : new URL(hub).host; }
  catch { return "this hub"; }
}

function SignedIn({ at, now }: { at: number | null; now: number }): ReactElement {
  const exact = at === null ? null : formatExactTimestamp(at);
  const recent = at === null ? null : formatTimestamp(at, now);
  if (exact === null || recent === null || at === null) return <span className="ub-muted">—</span>;
  const days = Math.floor(Math.max(0, now - at) / 86_400_000);
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const label = days < 30 ? recent.label : days < 365
    ? relative.format(-Math.floor(days / 30), "month")
    : relative.format(-Math.floor(days / 365), "year");
  return <time dateTime={exact.dateTime} title={exact.label}>{label}</time>;
}

function AdminRow({ admin, now, disabled, remove }: {
  admin: HubAdmin; now: number; disabled: boolean; remove: (admin: HubAdmin) => void;
}): ReactElement {
  return <tr>
    <th className={`${CELL} font-normal [overflow-wrap:anywhere]`} scope="row">@{admin.githubUsername}{admin.current && <span className="ub-muted ml-2">you</span>}
      <span className="ub-muted mt-1 block text-xs sm:hidden">Workspaces: {admin.workspaces} · Last signed in: <SignedIn at={admin.lastSignedInAt} now={now} /></span>
    </th>
    <td className={SECONDARY_CELL}>{admin.workspaces}</td>
    <td className={SECONDARY_CELL}><SignedIn at={admin.lastSignedInAt} now={now} /></td>
    <td className={`${CELL} w-20 sm:w-auto`}>{!admin.current && <AlertDialog>
      <AlertDialogTrigger asChild><button type="button" className="min-h-8 [@media(any-pointer:coarse)]:min-h-11 cursor-pointer rounded-(--radius-sm) border-0 bg-transparent px-2 font-[inherit] text-sm text-muted-foreground hover:enabled:bg-accent hover:enabled:text-foreground disabled:opacity-50" disabled={disabled}
        aria-label={`Remove ${admin.githubUsername}`}>Remove</button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Remove @{admin.githubUsername} as a hub administrator?</AlertDialogTitle>
        <AlertDialogDescription>This account loses hub administration and cannot add workspaces. Its workspace memberships and roles stay.</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={() => remove(admin)}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}</td>
  </tr>;
}

export function HubSettings({ page, administration }: {
  page: "hub-admins" | "hub-workspaces"; administration: HubAdministration;
}): ReactElement {
  const { admin, authority, request } = administration;
  const [list, setList] = useState<AccessAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const now = useTimestampClock();
  const refresh = useCallback(async (signal: AbortSignal): Promise<void> => {
    setList(null);
    const admins = new Map<string, HubAdmin>();
    const workspaces = new Map<string, HubWorkspace>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const answer = await request({ operation: page === "hub-admins" ? "list-hub-admins" : "list-hub-workspaces",
        ...(cursor === undefined ? {} : { cursor }) }, signal);
      if (signal.aborted) return;
      if (answer.status !== "ok") { setList(answer); return; }
      for (const person of answer.admins ?? []) admins.set(person.principalId, person);
      for (const workspace of answer.workspaces ?? []) {
        const previous = workspaces.get(workspace.workspaceId);
        workspaces.set(workspace.workspaceId, { ...workspace,
          admins: [...new Set([...(previous?.admins ?? []), ...workspace.admins])] });
      }
      if (answer.nextCursor === null) {
        setList({ ...answer, ...(page === "hub-admins" ? { admins: [...admins.values()] } : { workspaces: [...workspaces.values()] }) });
        return;
      }
      if (answer.nextCursor === undefined || seen.has(answer.nextCursor)) {
        setList({ status: "hub-down", hub: answer.hub });
        return;
      }
      seen.add(answer.nextCursor);
      cursor = answer.nextCursor;
    }
  }, [page, request]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setList(null); setFeedback(null); setBusy(false);
    if (admin) void refresh(controller.signal);
    return () => { controller.abort(); lifetime.current = null; };
  }, [admin, refresh]);

  const remove = async (person: HubAdmin): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (!admin || busy || signal === undefined || signal.aborted) return;
    setBusy(true); setFeedback(null);
    const result = await request({ operation: "remove-hub-admin", principalId: person.principalId }, signal);
    if (signal.aborted) return;
    setFeedback({ ok: result.status === "ok", text: result.status === "ok"
      ? `@${person.githubUsername} removed as a hub administrator.` : failure(result.status) });
    if (result.status !== "forbidden" && result.status !== "sign-in-required") await refresh(signal);
    if (!signal.aborted) setBusy(false);
  };
  const ready = admin && list?.status === "ok";

  return <section className="ub-pane ub-document-pane" data-settings-page aria-labelledby="ub-settings-title">
    <div className="ub-column flex flex-col gap-4">
      <h1 id="ub-settings-title" className="ub-heading mt-0 mb-0 font-(family-name:--font-display) font-medium">{page === "hub-admins" ? "Admins" : "Workspaces"}</h1>
      <p className="m-0 text-sm">{page === "hub-admins" ? `Hub admins of ${host(authority?.hub ?? null)}.` : "Workspaces this hub serves."}</p>
      {authority === null ? <p className="m-0 text-sm" role="status">Reading hub access…</p> :
        !admin ? <p className="m-0 text-sm" role="alert">{failure(authority.status)}</p> :
        list === null ? <p className="m-0 text-sm" role="status">Reading from the hub…</p> :
        list.status !== "ok" ? <p className="m-0 text-sm" role="alert">{failure(list.status)}</p> : null}
      {feedback !== null && <p className="m-0 text-sm" role={feedback.ok ? "status" : "alert"}>{feedback.text}</p>}
      {ready && <table className="w-full table-fixed border-collapse sm:table-auto" aria-label={page === "hub-admins" ? "Hub admins" : "Hub workspaces"}>
        {page === "hub-admins" ? <>
          <thead><tr><th className={CELL} scope="col">Account</th><th className={SECONDARY_CELL} scope="col">Workspaces</th><th className={SECONDARY_CELL} scope="col">Last signed in</th><th className={`${CELL} w-20 sm:w-auto`} scope="col"><span className="ub-sr-only">Actions</span></th></tr></thead>
          <tbody>{list.admins?.map((person) => <AdminRow key={person.principalId} admin={person} now={now} disabled={busy} remove={(person) => { void remove(person); }} />)}</tbody>
        </> : <>
          <thead><tr><th className={CELL} scope="col">Workspace</th><th className={SECONDARY_CELL} scope="col">Members</th><th className={SECONDARY_CELL} scope="col">Admins</th></tr></thead>
          <tbody>{list.workspaces?.map((workspace) => <tr key={workspace.workspaceId}>
            <th className={`${CELL} font-normal [overflow-wrap:anywhere]`} scope="row">{workspace.name ?? <span className="ub-muted">Unnamed workspace</span>}<span className="ub-muted mt-1 block font-(family-name:--font-mono) text-xs" title={workspace.workspaceId}>{workspace.workspaceId.slice(0, 8)}</span>
              <span className="ub-muted mt-1 block text-xs sm:hidden">Members: {workspace.members} · Admins: {workspace.admins.length === 0 ? "—" : workspace.admins.map((name) => `@${name}`).join(", ")}</span>
            </th>
            <td className={SECONDARY_CELL}>{workspace.members}</td>
            <td className={SECONDARY_CELL}>{workspace.admins.length === 0 ? <span className="ub-muted">—</span> : workspace.admins.map((name) => `@${name}`).join(", ")}</td>
          </tr>)}</tbody>
        </>}
      </table>}
    </div>
  </section>;
}
