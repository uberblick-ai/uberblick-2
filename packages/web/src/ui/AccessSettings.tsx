/** Online-only account management, independent of collaborative workspace state. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { LocalServing } from "../config.js";
import { parseWorkspaceId } from "@uberblick/schema";
import { createWorkspaceAccessClient } from "../shell/workspace-access.js";
import type { AccessAction, AccessAnswer, AccessDevice, AccessMember, AccessRole } from "../shell/workspace-access.js";
import type { Workspace } from "./route.js";
import { Button } from "./shadcn/button.js";
import { Input } from "./shadcn/input.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "./shadcn/alert-dialog.js";

const CARD = "flex flex-col gap-3 rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground";
const CELL = "border-b border-(--border) px-2 py-3 text-left text-sm last:border-b-0";
const SELECT = "min-h-9 rounded-(--radius-sm) border border-input bg-card px-2 text-sm";

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
    case "device-not-found": return "The hub refused this change: that device is no longer signed in. Refresh the list.";
    case "member-not-found": return "The hub refused this change: that account is no longer a member. Refresh the list.";
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
    <option value="member">member</option><option value="admin">admin</option>
  </select>;
}

function ConfirmAction({ trigger, title, description, action, disabled, onConfirm }: {
  trigger: string; title: string; description: string; action: string;
  disabled: boolean; onConfirm: () => void;
}): ReactElement {
  return <AlertDialog>
    <AlertDialogTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled}>{trigger}</Button></AlertDialogTrigger>
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

function MemberRow({ member, disabled, change, remove }: {
  member: AccessMember; disabled: boolean;
  change: (member: AccessMember, role: AccessRole) => void; remove: (member: AccessMember) => void;
}): ReactElement {
  const [draft, setDraft] = useState(member.role);
  useEffect(() => setDraft(member.role), [member]);
  return <tr>
    <th className={CELL} scope="row">{member.githubUsername}</th>
    <td className={CELL}>{member.role}</td>
    <td className={CELL}><div className="flex flex-wrap items-center gap-2">
      <RoleSelect label={`Role for ${member.githubUsername}`} value={draft} onChange={setDraft} disabled={disabled} />
      <Button type="button" variant="outline" size="sm" disabled={disabled || draft === member.role}
        aria-label={`Save role for ${member.githubUsername}`} onClick={() => change(member, draft)}>Save role</Button>
      <ConfirmAction trigger={`Remove ${member.githubUsername}`} title={`Remove ${member.githubUsername}?`}
        description="This person loses this workspace on every device. Documents already downloaded stay where they are."
        action="Remove member" disabled={disabled} onConfirm={() => remove(member)} />
    </div></td>
  </tr>;
}

export function AccessSettings({ workspace, serving, subject }: {
  workspace: Workspace; serving: LocalServing | null; subject: string;
}): ReactElement {
  let servedWorkspace: string | null = null;
  try { if (serving?.workspace !== null && serving?.workspace !== undefined) servedWorkspace = parseWorkspaceId(serving.workspace).uuid; }
  catch { /* A refused configuration must never name a management target. */ }
  const available = serving !== null && servedWorkspace === workspace.uuid && !serving.rebound;
  const client = useMemo(() => createWorkspaceAccessClient(workspace.uuid, subject), [workspace.uuid, subject]);
  const lifetime = useRef<AbortController | null>(null);
  const [ownRole, setOwnRole] = useState<AccessAnswer | null>(null);
  const [devices, setDevices] = useState<AccessAnswer | null>(null);
  const [members, setMembers] = useState<AccessAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ applied: boolean; text: string } | null>(null);
  const [handle, setHandle] = useState("");
  const [resolved, setResolved] = useState<{ githubAccountId: string; githubUsername: string } | null>(null);
  const [grantRole, setGrantRole] = useState<AccessRole>("member");

  const request = useCallback(async (action: AccessAction, signal: AbortSignal): Promise<AccessAnswer> => {
    try { return await client(action, signal); }
    catch { return { status: "hub-down", hub: null }; }
  }, [client]);
  const refresh = useCallback(async (signal: AbortSignal): Promise<void> => {
    setLoading(true);
    // Neither workspace membership nor a failed role read controls own devices.
    const [role, ownDevices] = await Promise.all([
      request({ operation: "own-role", workspaceId: workspace.uuid }, signal),
      request({ operation: "list-devices" }, signal),
    ]);
    if (signal.aborted) return;
    setOwnRole(role); setDevices(ownDevices); setMembers(null); setResolved(null);
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
    setOwnRole(null); setDevices(null); setMembers(null); setResolved(null);
    if (available) void refresh(controller.signal);
    else setLoading(false);
    return () => { controller.abort(); lifetime.current = null; };
  }, [available, refresh]);

  const hub = ownRole?.hub ?? devices?.hub ?? null;
  const admin = ownRole?.status === "ok" && ownRole.role === "admin";
  const membershipReady = admin && members?.status === "ok" && !loading && !busy;
  const devicesReady = devices?.status === "ok" && !loading && !busy;

  const mutate = async (action: AccessAction, success: string): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (signal === undefined || signal.aborted || busy) return;
    setBusy(true); setFeedback(null);
    const result = await request(action, signal);
    if (signal.aborted) return;
    const applied = result.status === "ok" || result.status === "already-member" ||
      (result.status === "closure-failed" && result.applied === true);
    const text = result.status === "already-member" && result.member !== undefined
      ? `${result.member.githubUsername} is already a member as ${result.member.role}.`
      : applied ? `${success}${result.status === "closure-failed" ? " The change was applied; the hub could not close every active connection." : ""}`
      : failure(result.status, result.hub);
    // An acknowledged self-removal or revocation stays acknowledged even when
    // its fresh read loses membership or this computer's credential.
    setFeedback({ applied, text });
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
      setGrantRole("member");
    } else {
      setFeedback({ applied: false, text: result.status === "invalid-request"
        ? "Enter a GitHub handle, without @, a link or spaces."
        : failure(result.status, result.hub) });
      if (result.status !== "invalid-request" && result.status !== "account-not-found" && result.status !== "lookup-unavailable") await refresh(signal);
    }
    if (!signal.aborted) setBusy(false);
  };

  const existing = resolved === null ? undefined : members?.members?.find((member) => member.githubAccountId === resolved.githubAccountId);
  const revoke = (device: AccessDevice): void => {
    void mutate({ operation: "revoke-device", deviceId: device.deviceId }, device.current
      ? `This computer was revoked. Its sync with the hub stops until ub auth login ${hub ?? "<hub>"} is run again. Documents already downloaded stay where they are.`
      : "Device revoked. Documents already downloaded stay where they are.");
  };

  return <section className="ub-pane" data-settings-page aria-labelledby="ub-settings-title">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 id="ub-settings-title" className="mt-0 mb-0 text-2xl font-medium">Access</h1>
      <p className="m-0 text-sm">Access is read from the hub on each visit and after each change. Changes require a reachable hub.</p>
      {!available ? <div className={CARD}><p className="m-0 text-sm" role="status">{serving?.rebound
        ? "This project's workspace binding changed. Restart ub open to manage access."
        : "Manage access from this workspace's locally served page. Run ub open in its project."}</p></div> : <>
        <div className={CARD}>
          <h2 className="m-0 text-base font-medium">Workspace access</h2>
          {loading && <p className="m-0 text-sm" role="status">Reading access from the hub…</p>}
          {ownRole !== null && <p className="m-0 text-sm" role={ownRole.status === "ok" ? "status" : "alert"}>
            {ownRole.status === "ok" ? `Your role: ${ownRole.role}.` : failure(ownRole.status, ownRole.hub)}
          </p>}
          <Button type="button" variant="outline" className="self-start" disabled={loading || busy} onClick={() => {
            const signal = lifetime.current?.signal; if (signal !== undefined) void refresh(signal);
          }}>Refresh access</Button>
        </div>
        {feedback !== null && <p className="m-0 text-sm" role={feedback.applied ? "status" : "alert"}>{feedback.text}</p>}
        {admin && <section className={CARD} aria-labelledby="ub-members-title">
          <h2 id="ub-members-title" className="m-0 text-base font-medium">Members</h2>
          {members !== null && members.status !== "ok" && <p className="m-0 text-sm" role="alert">{failure(members.status, members.hub)}</p>}
          {members?.status === "ok" && <>
            <form className="flex flex-col gap-2" onSubmit={(event) => { void lookup(event); }}>
              <label htmlFor="ub-github-account" className="text-sm font-medium">GitHub account</label>
              <div className="flex gap-2"><Input id="ub-github-account" value={handle} disabled={!membershipReady}
                autoComplete="off" maxLength={39} placeholder="GitHub handle" onChange={(event) => {
                  setHandle(event.currentTarget.value); setResolved(null); setFeedback(null);
                }} /><Button type="submit" disabled={!membershipReady || handle.trim() === ""}>Look up account</Button></div>
            </form>
            {resolved !== null && <div className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-3">
              <p className="m-0 text-sm">{resolved.githubUsername} (GitHub account {resolved.githubAccountId})</p>
              {existing !== undefined ? <p className="m-0 text-sm" role="status">Already a member as {existing.role}.</p> : <>
                <p className="m-0 text-sm">Confirm that this is the account you want to add.</p>
                <RoleSelect label="Role for new account" value={grantRole} onChange={setGrantRole} disabled={!membershipReady} />
                <Button type="button" className="self-start" disabled={!membershipReady} onClick={() => {
                  void mutate({ operation: "grant-member", workspaceId: workspace.uuid, githubAccountId: resolved.githubAccountId, role: grantRole }, `${resolved.githubUsername} added as ${grantRole}.`);
                }}>Confirm and add account</Button>
              </>}
            </div>}
            <div className="overflow-x-auto"><table className="w-full border-collapse" aria-label="Members">
              <thead><tr><th className={CELL} scope="col">GitHub account</th><th className={CELL} scope="col">Role</th><th className={CELL} scope="col">Actions</th></tr></thead>
              <tbody>{members.members?.map((member) => <MemberRow key={member.principalId} member={member} disabled={!membershipReady}
                change={(person, next) => { void mutate({ operation: "change-role", workspaceId: workspace.uuid, principalId: person.principalId, role: next }, `${person.githubUsername}'s role changed to ${next}.`); }}
                remove={(person) => { void mutate({ operation: "remove-member", workspaceId: workspace.uuid, principalId: person.principalId }, `${person.githubUsername} removed from this workspace. Documents already downloaded stay where they are.`); }} />)}</tbody>
            </table></div>
          </>}
        </section>}
        {devices !== null && devices.status !== "local-only" &&
          !(devices.status !== "ok" && devices.status === ownRole?.status && devices.hub === ownRole.hub) &&
          <section className={CARD} aria-labelledby="ub-devices-title">
          <h2 id="ub-devices-title" className="m-0 text-base font-medium">Your devices</h2>
          {devices.status !== "ok" ? <p className="m-0 text-sm" role="alert">{failure(devices.status, devices.hub)}</p> :
            devices.devices?.length === 0 ? <p className="m-0 text-sm">No signed-in devices.</p> : <div className="overflow-x-auto"><table className="w-full border-collapse" aria-label="Your devices">
              <thead><tr><th className={CELL} scope="col">Device</th><th className={CELL} scope="col">Signed in</th><th className={CELL} scope="col">Actions</th></tr></thead>
              <tbody>{devices.devices?.map((device) => <tr key={device.deviceId}>
                <th className={`${CELL} max-w-56 wrap-anywhere`} scope="row">{device.deviceId}{device.current && <span className="mt-1 block font-normal">This computer</span>}</th>
                <td className={CELL}><time dateTime={new Date(device.signedInAt).toISOString()}>{new Date(device.signedInAt).toLocaleString()}</time></td>
                <td className={CELL}><ConfirmAction trigger={`Revoke device ${device.deviceId}`} title={device.current ? "Revoke this computer?" : "Revoke device?"}
                  description={`This one device of yours loses access to this hub. Documents already downloaded stay where they are.${device.current ? ` This computer's sync with the hub stops until ub auth login ${hub ?? "<hub>"} is run again.` : ""}`}
                  action="Revoke device" disabled={!devicesReady} onConfirm={() => revoke(device)} /></td>
              </tr>)}</tbody>
            </table></div>}
        </section>}
      </>}
    </div>
  </section>;
}
