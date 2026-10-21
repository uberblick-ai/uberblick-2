/** Online-only account management, independent of collaborative workspace state. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { LocalServing } from "../../config.js";
import { parseWorkspaceId } from "@uberblick/schema";
import { toast } from "sonner";
import { createWorkspaceAccessClient } from "../../shell/workspace-access.js";
import type { AccessAction, AccessAnswer, AccessMember, AccessRole } from "../../shell/workspace-access.js";
import type { Workspace } from "../route.js";
import { Button } from "../shadcn/button.js";
import { Input } from "../shadcn/input.js";
import { CELL, ConfirmAction, FeedbackLine, ROW_HEADER, SettingsPage, TableHead, acknowledged, askHub, loginFailure, useHubMutation } from "./settings-kit.js";

const SELECT = "min-h-9 [@media(any-pointer:coarse)]:min-h-11 rounded-(--radius-sm) border border-input bg-card px-2 ub-type-ui";

function roleName(role: AccessRole): string {
  return role === "admin" ? "Admin" : "Member";
}

function failure(status: string, hub: string | null): string {
  switch (status) {
    case "local-only": return "This local workspace has no members. Share it with ub workspace promote <hub> to manage access.";
    case "protocol-mismatch": return "The app and hub protocol versions differ. Update ub and the hub, restart ub open, then retry.";
    case "update-required": return "The hub's management response could not be understood. Update ub and the hub, restart ub open, then retry.";
    case "hub-down": return "The hub cannot be reached. Reconnect to the hub, then retry.";
    case "forbidden": return "The hub refused access. Ask a workspace admin to grant the access you need.";
    case "last-admin": return "The hub refused this change: the last admin cannot be removed or demoted.";
    case "account-not-found": return "No such GitHub account. Check the handle and look it up again.";
    case "lookup-unavailable": return "GitHub account lookup is unavailable. Retry the lookup; no access was granted.";
    case "member-not-found": return "The hub refused this change: that account is no longer a member.";
    default: return loginFailure(status, hub, "retry") ?? "Access management is unavailable. Retry; if it continues, restart ub open and check the hub.";
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

function MemberRow({ member, current, disabled, change, remove }: {
  member: AccessMember; current: boolean; disabled: boolean;
  change: (member: AccessMember, role: AccessRole) => void; remove: (member: AccessMember) => void;
}): ReactElement {
  const [role, setRole] = useState(member.role);
  useEffect(() => setRole(member.role), [member]);
  return <tr>
    <th className={ROW_HEADER} scope="row">{member.githubUsername}{current && <span className="ub-muted ml-2">you</span>}</th>
    <td className={CELL}>
      <RoleSelect label={`Role for ${member.githubUsername}`} value={role} onChange={(next) => {
        if (next !== member.role) { setRole(next); change(member, next); }
      }} disabled={disabled} />
    </td>
    <td className={CELL}>
      <ConfirmAction trigger="Remove" label={`Remove ${member.githubUsername}`} title={`Remove ${member.githubUsername}?`}
        description="This person loses this workspace on every device. Documents already downloaded stay where they are."
        action="Remove member" variant="destructive" disabled={disabled} onConfirm={() => remove(member)} />
    </td>
  </tr>;
}

export function AccessSettings({ workspace, serving, subject, verifiedHandle }: {
  workspace: Workspace; serving: LocalServing | null; subject: string; verifiedHandle: string | null;
}): ReactElement {
  let servedWorkspace: string | null = null;
  try { if (serving?.workspace !== null && serving?.workspace !== undefined) servedWorkspace = parseWorkspaceId(serving.workspace).uuid; }
  catch { /* A refused configuration must never name a management target. */ }
  const available = serving !== null && servedWorkspace === workspace.uuid && !serving.rebound;
  const client = useMemo(() => createWorkspaceAccessClient(workspace.uuid, subject), [workspace.uuid, subject]);
  const [ownRole, setOwnRole] = useState<AccessAnswer | null>(null);
  const [members, setMembers] = useState<AccessAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState("");
  const [resolved, setResolved] = useState<{ githubAccountId: string; githubUsername: string } | null>(null);

  const request = useCallback((action: AccessAction, signal: AbortSignal) => askHub(client, action, signal), [client]);
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
  const load = useCallback((signal: AbortSignal) => {
    setOwnRole(null); setMembers(null); setResolved(null);
    if (available) void refresh(signal);
    else setLoading(false);
  }, [available, refresh]);
  const { busy, feedback, setFeedback, run } = useHubMutation(load);

  const admin = ownRole?.status === "ok" && ownRole.role === "admin";
  const membershipReady = admin && members?.status === "ok" && !loading && !busy;

  const mutate = (action: AccessAction, success: string): void => {
    void run(async (signal) => {
      const result = await request(action, signal);
      if (signal.aborted) return;
      const done = result.status !== "already-member" ? acknowledged(result, success)
        : result.member === undefined ? success
        : `${result.member.githubUsername} is already a member as ${roleName(result.member.role)}.`;
      // An acknowledged self-removal stays acknowledged when its fresh read
      // loses workspace membership.
      if (action.operation === "change-role" && done !== null) {
        toast.success("Role changed", { id: "workspace-role" });
      } else setFeedback({ applied: done !== null, text: done ?? failure(result.status, result.hub) });
      await refresh(signal);
    });
  };

  const lookup = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!membershipReady || handle.trim() === "") return;
    void run(async (signal) => {
      setResolved(null);
      const result = await request({ operation: "resolve-account", workspaceId: workspace.uuid, githubUsername: handle.trim() }, signal);
      if (signal.aborted) return;
      if (result.status === "ok" && result.githubAccountId !== undefined && result.githubUsername !== undefined) {
        setResolved({ githubAccountId: result.githubAccountId, githubUsername: result.githubUsername });
        return;
      }
      setFeedback({ applied: false, text: result.status === "invalid-request"
        ? "Enter a GitHub handle, without @, a link or spaces."
        : failure(result.status, result.hub) });
      if (result.status !== "invalid-request" && result.status !== "account-not-found" && result.status !== "lookup-unavailable") await refresh(signal);
    });
  };

  const existing = resolved === null ? undefined : members?.members?.find((member) => member.githubAccountId === resolved.githubAccountId);

  const note = !available ? serving?.rebound
    ? "This project's workspace binding changed. Restart ub open to manage access."
    : "Manage access from this workspace's locally served page. Run ub open in its project."
    : ownRole === null ? loading ? "Reading access from the hub…" : undefined
    : ownRole.status !== "ok" ? failure(ownRole.status, ownRole.hub)
    : ownRole.role === "admin" ? "You are an admin of this workspace." : "You are a member of this workspace.";

  return <SettingsPage title="Members" gap="gap-4" note={note}
    noteRole={available && ownRole !== null && ownRole.status !== "ok" ? "alert" : "status"}>
    {available && <>
      <FeedbackLine feedback={feedback} />
      {admin && <>
        {members !== null && members.status !== "ok" && <p className="m-0 ub-type-ui" role="alert">{failure(members.status, members.hub)}</p>}
        {members?.status === "ok" && <>
          <section className="mt-4 flex flex-col gap-3" aria-labelledby="ub-add-member-title">
          <h2 id="ub-add-member-title" className="m-0 ub-type-h2 font-semibold">Add a member</h2>
          <form className="flex flex-col gap-2" onSubmit={lookup}>
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
                mutate({ operation: "grant-member", workspaceId: workspace.uuid, githubAccountId: resolved.githubAccountId, role: "member" }, `${resolved.githubUsername} added as Member.`);
              }}>Add as member</Button>}
          </div>}
          </section>
          <section className="mt-4 flex flex-col gap-3" aria-labelledby="ub-members-title">
          <h2 id="ub-members-title" className="m-0 ub-type-h2 font-semibold">Members</h2>
          <div className="overflow-x-auto"><table className="w-full border-collapse" aria-label="Members">
            <TableHead columns={["Account", "Role"]} actions />
            <tbody>{members.members?.map((member) => <MemberRow key={member.principalId} member={member} disabled={!membershipReady}
              current={verifiedHandle !== null && member.githubUsername.toLowerCase() === verifiedHandle.toLowerCase()}
              change={(person, next) => { mutate({ operation: "change-role", workspaceId: workspace.uuid, principalId: person.principalId, role: next }, "Role changed"); }}
              remove={(person) => { mutate({ operation: "remove-member", workspaceId: workspace.uuid, principalId: person.principalId }, `${person.githubUsername} removed from this workspace. Documents already downloaded stay where they are.`); }} />)}</tbody>
          </table></div>
          </section>
        </>}
      </>}
    </>}
  </SettingsPage>;
}
