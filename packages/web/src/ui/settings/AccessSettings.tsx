/** Online-only account management, independent of collaborative workspace state. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { LocalServing } from "../../config.js";
import { toast } from "sonner";
import { createWorkspaceAccessClient } from "../../shell/workspace-access.js";
import type { AccessAction, AccessAnswer, AccessMember, AccessRole } from "../../shell/workspace-access.js";
import type { Workspace } from "../route.js";
import { servesWorkspace } from "./hub-administration.js";
import { Button } from "../shadcn/button.js";
import { Input } from "../shadcn/input.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "../shadcn/alert-dialog.js";

const CELL = "border-b border-(--border) px-2 py-3 text-left last:border-b-0";
const SELECT = "min-h-9 [@media(any-pointer:coarse)]:min-h-11 rounded-(--radius-sm) border border-input bg-card px-2 ub-type-ui";
const ROW_ACTION = "min-h-8 [@media(any-pointer:coarse)]:min-h-11 cursor-pointer rounded-(--radius-sm) border-0 bg-transparent px-2 font-[inherit] ub-type-ui text-muted-foreground hover:enabled:bg-accent hover:enabled:text-foreground disabled:opacity-50";

function roleName(role: AccessRole): string {
  return role === "admin" ? "Admin" : "Member";
}

function failure(status: string, hub: string | null): string {
  switch (status) {
    case "local-only": return "This local workspace has no members. Share it with ub workspace promote <hub> to manage access.";
    case "not-configured": return "This hub has no GitHub sign-in configured. Ask the hub owner to configure GitHub sign-in.";
    case "sign-in-required": return `Sign-in is required. Run ub auth login ${hub ?? "<hub>"} on this computer, then retry.`;
    case "protocol-mismatch": return "The app and hub protocol versions differ. Update ub and the hub, restart ub open, then retry.";
    case "update-required": return "The hub's management response could not be understood. Update ub and the hub, restart ub open, then retry.";
    case "hub-down": return "The hub cannot be reached. Reconnect to the hub, then retry.";
    case "forbidden": return "The hub refused access. Ask a workspace admin to grant the access you need.";
    case "last-admin": return "The hub refused this change: the last admin cannot be removed or demoted.";
    case "account-not-found": return "No such GitHub account. Check the handle and look it up again.";
    case "lookup-unavailable": return "GitHub account lookup is unavailable. Retry the lookup; no access was granted.";
    case "member-not-found": return "The hub refused this change: that account is no longer a member.";
    case "credential-store":
    case "credential-store-refused":
    case "credential-store-unreadable": return "The login on this computer could not be read. Check your credential store, then retry.";
    case "renewal-unavailable": return "The hub could not renew this computer's login. Reconnect to the hub, then retry.";
    default: return "Access management is unavailable. Retry; if it continues, restart ub open and check the hub.";
  }
}

function RoleSelect({ value, onChange, label, disabled }: {
  value: AccessRole; onChange: (role: AccessRole) => void; label: string; disabled: boolean;
}): ReactElement {
  return <select className={SELECT} aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onChange(event.currentTarget.value === "admin" ? "admin" : "member")}>
    <option value="member">Member</option><option value="admin">Admin</option>
  </select>;
}

function ConfirmAction({ trigger, triggerLabel, title, description, action, disabled, onConfirm, quiet = false }: {
  trigger: string; triggerLabel?: string; title: string; description: string; action: string;
  disabled: boolean; onConfirm: () => void; quiet?: boolean;
}): ReactElement {
  return <AlertDialog>
    <AlertDialogTrigger asChild>{quiet
      ? <button type="button" className={ROW_ACTION} disabled={disabled} aria-label={triggerLabel}>{trigger}</button>
      : <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={triggerLabel}>{trigger}</Button>}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={disabled} onClick={onConfirm}>{action}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

function MemberRow({ member, current, disabled, change, remove }: {
  member: AccessMember; current: boolean; disabled: boolean;
  change: (member: AccessMember, role: AccessRole) => void; remove: (member: AccessMember) => void;
}): ReactElement {
  const [role, setRole] = useState(member.role);
  useEffect(() => setRole(member.role), [member]);
  return <tr>
    <th className={`${CELL} font-normal wrap-anywhere`} scope="row">{member.githubUsername}{current && <span className="ub-muted ml-2">you</span>}</th>
    <td className={CELL}>
      <RoleSelect label={`Role for ${member.githubUsername}`} value={role} onChange={(next) => {
        if (next !== member.role) { setRole(next); change(member, next); }
      }} disabled={disabled} />
    </td>
    <td className={CELL}>
      <ConfirmAction trigger="Remove" triggerLabel={`Remove ${member.githubUsername}`} quiet title={`Remove ${member.githubUsername}?`}
        description="This person loses this workspace on every device. Documents already downloaded stay where they are."
        action="Remove member" disabled={disabled} onConfirm={() => remove(member)} />
    </td>
  </tr>;
}

export function AccessSettings({ workspace, serving, subject, verifiedHandle }: {
  workspace: Workspace; serving: LocalServing | null; subject: string; verifiedHandle: string | null;
}): ReactElement {
  const available = servesWorkspace(serving, workspace.uuid);
  const client = useMemo(() => createWorkspaceAccessClient(workspace.uuid, subject), [workspace.uuid, subject]);
  const lifetime = useRef<AbortController | null>(null);
  const [ownRole, setOwnRole] = useState<AccessAnswer | null>(null);
  const [members, setMembers] = useState<AccessAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ applied: boolean; text: string } | null>(null);
  const [handle, setHandle] = useState("");
  const [resolved, setResolved] = useState<{ githubAccountId: string; githubUsername: string } | null>(null);

  const request = useCallback(async (action: AccessAction, signal: AbortSignal): Promise<AccessAnswer> => {
    try { return await client(action, signal); }
    catch { return { status: "hub-down", hub: null }; }
  }, [client]);
  const refresh = useCallback(async (signal: AbortSignal): Promise<void> => {
    setLoading(true);
    const role = await request({ operation: "own-role", workspaceId: workspace.uuid }, signal);
    if (signal.aborted) return;
    setOwnRole(role); setMembers(null); setResolved(null);
    if (role.status === "ok" && role.role === "admin") {
      const list = await request({ operation: "list-members", workspaceId: workspace.uuid }, signal);
      if (signal.aborted) return;
      setMembers(list);
    }
    setLoading(false);
  }, [request, workspace.uuid]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setBusy(false);
    setOwnRole(null); setMembers(null); setResolved(null);
    if (available) void refresh(controller.signal);
    else setLoading(false);
    return () => { controller.abort(); lifetime.current = null; };
  }, [available, refresh]);

  const admin = ownRole?.status === "ok" && ownRole.role === "admin";
  const membershipReady = admin && members?.status === "ok" && !loading && !busy;

  const mutate = async (action: AccessAction, success: string): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (signal === undefined || signal.aborted || busy) return;
    setBusy(true); setFeedback(null);
    const result = await request(action, signal);
    if (signal.aborted) return;
    const applied = result.status === "ok" || result.status === "already-member" ||
      (result.status === "closure-failed" && result.applied === true);
    const text = result.status === "already-member" && result.member !== undefined
      ? `${result.member.githubUsername} is already a member as ${roleName(result.member.role)}.`
      : applied ? `${success}${result.status === "closure-failed" ? " The change was applied; the hub could not close every active connection." : ""}`
      : failure(result.status, result.hub);
    // An acknowledged self-removal stays acknowledged when its fresh read
    // loses workspace membership.
    if (action.operation === "change-role" && applied) {
      toast.success("Role changed", { id: "workspace-role" });
    } else setFeedback({ applied, text });
    await refresh(signal);
    if (!signal.aborted) setBusy(false);
  };

  const lookup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const signal = lifetime.current?.signal;
    if (!membershipReady || signal === undefined || signal.aborted || handle.trim() === "") return;
    setBusy(true); setFeedback(null); setResolved(null);
    const result = await request({ operation: "resolve-account", workspaceId: workspace.uuid, githubUsername: handle.trim() }, signal);
    if (signal.aborted) return;
    if (result.status === "ok" && result.githubAccountId !== undefined && result.githubUsername !== undefined) {
      setResolved({ githubAccountId: result.githubAccountId, githubUsername: result.githubUsername });
    } else {
      setFeedback({ applied: false, text: result.status === "invalid-request"
        ? "Enter a GitHub handle, without @, a link or spaces."
        : failure(result.status, result.hub) });
      if (result.status !== "invalid-request" && result.status !== "account-not-found" && result.status !== "lookup-unavailable") await refresh(signal);
    }
    if (!signal.aborted) setBusy(false);
  };

  const existing = resolved === null ? undefined : members?.members?.find((member) => member.githubAccountId === resolved.githubAccountId);

  return <section className="ub-pane ub-page-pane" data-settings-page aria-labelledby="ub-settings-title">
    <div className="ub-column gap-4">
      <div className="ub-page-header">
        <h1 id="ub-settings-title" className="ub-title">Members</h1>
        {!available ? <p className="m-0 ub-type-small" role="status">{serving?.rebound
          ? "This project's workspace binding changed. Restart ub open to manage access."
          : "Manage access from this workspace's locally served page. Run ub open in its project."}</p>
          : ownRole !== null ? <p className="m-0 ub-type-small" role={ownRole.status === "ok" ? "status" : "alert"}>
            {ownRole.status === "ok" ? ownRole.role === "admin"
              ? "You are an admin of this workspace." : "You are a member of this workspace."
              : failure(ownRole.status, ownRole.hub)}
          </p> : loading && <p className="m-0 ub-type-small" role="status">Reading access from the hub…</p>}
      </div>
      {available && <>
        {feedback !== null && <p className="m-0 ub-type-ui" role={feedback.applied ? "status" : "alert"}>{feedback.text}</p>}
        {admin && <>
          {members !== null && members.status !== "ok" && <p className="m-0 ub-type-ui" role="alert">{failure(members.status, members.hub)}</p>}
          {members?.status === "ok" && <>
            <section className="mt-4 flex flex-col gap-3" aria-labelledby="ub-add-member-title">
            <h2 id="ub-add-member-title" className="m-0 ub-type-h2 font-semibold">Add a member</h2>
            <form className="flex flex-col gap-2" onSubmit={(event) => { void lookup(event); }}>
              <label htmlFor="ub-github-account" className="ub-type-ui font-medium">GitHub handle</label>
              <div className="flex gap-2"><Input id="ub-github-account" value={handle} disabled={!membershipReady}
                autoComplete="off" maxLength={39} placeholder="GitHub handle" onChange={(event) => {
                  setHandle(event.currentTarget.value); setResolved(null); setFeedback(null);
                }} /><Button type="submit" variant="outline" disabled={!membershipReady || handle.trim() === ""}>Look up</Button></div>
            </form>
            {resolved !== null && <div className="flex flex-wrap items-center gap-3">
              <p className="m-0 ub-type-ui wrap-anywhere">{resolved.githubUsername} · GitHub account {resolved.githubAccountId}</p>
              {existing !== undefined ? <p className="m-0 ub-type-ui" role="status">Already a member as {roleName(existing.role)}.</p> :
                <Button type="button" className="self-start" disabled={!membershipReady} onClick={() => {
                  void mutate({ operation: "grant-member", workspaceId: workspace.uuid, githubAccountId: resolved.githubAccountId, role: "member" }, `${resolved.githubUsername} added as Member.`);
                }}>Add as member</Button>}
            </div>}
            </section>
            <section className="mt-4 flex flex-col gap-3" aria-labelledby="ub-members-title">
            <h2 id="ub-members-title" className="m-0 ub-type-h2 font-semibold">Members</h2>
            <div className="overflow-x-auto"><table className="w-full border-collapse" aria-label="Members">
              <thead><tr><th className={`${CELL} ub-type-ui`} scope="col">Account</th><th className={`${CELL} ub-type-ui`} scope="col">Role</th><th className={`${CELL} ub-type-ui`} scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{members.members?.map((member) => <MemberRow key={member.principalId} member={member} disabled={!membershipReady}
                current={verifiedHandle !== null && member.githubUsername.toLowerCase() === verifiedHandle.toLowerCase()}
                change={(person, next) => { void mutate({ operation: "change-role", workspaceId: workspace.uuid, principalId: person.principalId, role: next }, "Role changed"); }}
                remove={(person) => { void mutate({ operation: "remove-member", workspaceId: workspace.uuid, principalId: person.principalId }, `${person.githubUsername} removed from this workspace. Documents already downloaded stay where they are.`); }} />)}</tbody>
            </table></div>
            </section>
          </>}
        </>}
      </>}
    </div>
  </section>;
}
