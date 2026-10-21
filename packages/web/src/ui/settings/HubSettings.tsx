/** Hub-private administration, with live signed requests. */
import { useCallback, useState } from "react";
import type { ReactElement } from "react";
import type { AccessAction, AccessAnswer, HubAdmin, HubWorkspace } from "../../shell/workspace-access.js";
import type { HubAdministration } from "./hub-administration.js";
import { formatExactTimestamp, formatTimestamp, useTimestampClock } from "../timestamps.js";
import { CELL, ConfirmAction, FeedbackLine, ROW_HEADER, SettingsPage, TableHead, hubHost, useHubMutation } from "./settings-kit.js";

function failure(status: string): string {
  switch (status) {
    case "forbidden": return "The hub refused access. Ask a hub administrator for the access you need.";
    case "self-admin": return "You cannot remove yourself as a hub administrator.";
    case "last-admin": return "The hub refused this change: the last hub administrator cannot be removed.";
    case "admin-not-found": return "That account is no longer a hub administrator. Visit Admins again to read the current list.";
    case "workspace-not-found": return "That workspace is no longer on this hub. Visit Workspaces again to read the current list.";
    case "sign-in-required": return "Sign in to this workspace's hub with ub auth login, then visit this page again.";
    case "local-only": return "Hub administration is available only from a workspace bound to that hub.";
    case "protocol-mismatch":
    case "update-required": return "Update ub and the hub, restart ub open, then visit this page again.";
    default: return "The hub cannot be reached. Reconnect, then visit this page again.";
  }
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
    <th className={ROW_HEADER} scope="row">@{admin.githubUsername}{admin.current && <span className="ub-muted ml-2">you</span>}
    </th>
    <td className={CELL}>{admin.workspaces}</td>
    <td className={CELL}><SignedIn at={admin.lastSignedInAt} now={now} /></td>
    <td className={CELL}>{!admin.current && <ConfirmAction trigger="Remove" label={`Remove ${admin.githubUsername}`}
      title={`Remove @${admin.githubUsername} as a hub administrator?`}
      description="This account loses hub administration and cannot add workspaces. Its workspace memberships and roles stay."
      disabled={disabled} onConfirm={() => remove(admin)} />}</td>
  </tr>;
}

function WorkspaceRow({ workspace, disabled, changeStatus }: {
  workspace: HubWorkspace; disabled: boolean; changeStatus: (workspace: HubWorkspace) => void;
}): ReactElement {
  const suspended = workspace.status === "suspended";
  const action = suspended ? "Restore" : "Suspend";
  const name = workspace.name ?? `Unnamed workspace (${workspace.workspaceId.slice(0, 8)})`;
  return <tr>
    <th className={ROW_HEADER} scope="row">{workspace.name ?? <span className="ub-muted">Unnamed workspace</span>}<span className="ub-muted mt-1 block font-(family-name:--font-mono) ub-type-caption" title={workspace.workspaceId}>{workspace.workspaceId.slice(0, 8)}</span>
    </th>
    <td className={`${CELL} tabular-nums`}>{workspace.members}</td>
    <td className={CELL}>{workspace.admins.length === 0 ? <span className="ub-muted">—</span> : workspace.admins.map((name) => `@${name}`).join(", ")}</td>
    <td className={CELL}>{suspended ? "Suspended" : "Active"}</td>
    <td className={CELL}><ConfirmAction trigger={action} label={`${action} ${name}`} title={`${action} "${name}"?`}
      description={suspended
        ? "Its members can sync with this hub again, without signing in or being added again."
        : "This stops its sync for everyone. Its documents and members stay, and downloaded copies remain usable. You can restore it later."}
      disabled={disabled} onConfirm={() => changeStatus(workspace)} /></td>
  </tr>;
}

export function HubSettings({ page, administration }: {
  page: "hub-admins" | "hub-workspaces"; administration: HubAdministration;
}): ReactElement {
  const { admin, authority, request } = administration;
  const [list, setList] = useState<AccessAnswer | null>(null);
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

  const load = useCallback((signal: AbortSignal) => {
    setList(null);
    if (admin) void refresh(signal);
  }, [admin, refresh]);
  const { busy, feedback, setFeedback, run } = useHubMutation(load);

  const change = (action: AccessAction, success: string): void => {
    if (!admin) return;
    void run(async (signal) => {
      const result = await request(action, signal);
      if (signal.aborted) return;
      setFeedback({ applied: result.status === "ok", text: result.status === "ok" ? success : failure(result.status) });
      if (result.status !== "forbidden" && result.status !== "sign-in-required") await refresh(signal);
    });
  };
  const remove = (person: HubAdmin): void => change({ operation: "remove-hub-admin", principalId: person.principalId },
    `@${person.githubUsername} removed as a hub administrator.`);
  const changeStatus = (workspace: HubWorkspace): void => {
    const suspended = workspace.status === "suspended";
    change({ operation: suspended ? "restore-workspace" : "suspend-workspace", workspaceId: workspace.workspaceId },
      `${workspace.name ?? `Workspace ${workspace.workspaceId.slice(0, 8)}`} ${suspended ? "restored" : "suspended"}.`);
  };
  const ready = admin && list?.status === "ok";

  return <SettingsPage title={page === "hub-admins" ? "Admins" : "Workspaces"} gap="gap-4"
    note={page === "hub-admins" ? `Hub admins of ${hubHost(authority?.hub ?? null)}.` : "Workspaces this hub serves. Suspending one stops its sync for everyone; its documents and members stay."}>
    {authority === null ? <p className="m-0 ub-type-ui" role="status">Reading hub access…</p> :
      !admin ? <p className="m-0 ub-type-ui" role="alert">{failure(authority.status)}</p> :
      list === null ? <p className="m-0 ub-type-ui" role="status">Reading from the hub…</p> :
      list.status !== "ok" ? <p className="m-0 ub-type-ui" role="alert">{failure(list.status)}</p> : null}
    <FeedbackLine feedback={feedback} />
    {ready && <table className="w-full table-auto border-collapse" aria-label={page === "hub-admins" ? "Hub admins" : "Hub workspaces"}>
      {page === "hub-admins" ? <>
        <TableHead columns={["Account", "Workspaces", "Last signed in"]} actions />
        <tbody>{list.admins?.map((person) => <AdminRow key={person.principalId} admin={person} now={now} disabled={busy} remove={remove} />)}</tbody>
      </> : <>
        <TableHead columns={["Workspace", "Members", "Admins", "Status"]} actions />
        <tbody>{list.workspaces?.map((workspace) => <WorkspaceRow key={workspace.workspaceId} workspace={workspace} disabled={busy} changeStatus={changeStatus} />)}</tbody>
      </>}
    </table>}
  </SettingsPage>;
}
