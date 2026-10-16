/** Devices belong to the hub login, independently of workspace membership. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { AccessAction, AccessAnswer, AccessDevice } from "../../shell/workspace-access.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "../shadcn/alert-dialog.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";

const CELL = "border-b border-(--border) px-2 py-3 text-left";
const ROW_ACTION = "min-h-8 [@media(any-pointer:coarse)]:min-h-11 cursor-pointer rounded-(--radius-sm) border-0 bg-transparent px-2 font-[inherit] ub-type-ui text-muted-foreground hover:enabled:bg-accent hover:enabled:text-foreground disabled:opacity-50";

function failure(status: string, hub: string | null): string {
  switch (status) {
    case "sign-in-required": return `Sign-in is required. Run ub auth login ${hub ?? "<hub>"} on this computer, then visit Devices again.`;
    case "local-only": return "Devices are available from a workspace bound to the hub you are signed in to.";
    case "not-configured": return "This hub has no GitHub sign-in configured. Ask the hub owner to configure GitHub sign-in.";
    case "forbidden": return "The hub refused access to these devices. Sign in to this hub again, then visit Devices.";
    case "device-not-found": return "The hub refused this change: that device is no longer signed in. Visit Devices again to read the current list.";
    case "protocol-mismatch":
    case "update-required": return "Update ub and the hub, restart ub open, then visit Devices again.";
    case "credential-store":
    case "credential-store-refused":
    case "credential-store-unreadable": return "The login on this computer could not be read. Check your credential store, then visit Devices again.";
    case "renewal-unavailable": return "The hub could not renew this computer's login. Reconnect to the hub, then visit Devices again.";
    default: return "The hub cannot be reached. Reconnect, then visit Devices again.";
  }
}

function host(hub: string | null): string {
  try { return hub === null ? "this hub" : new URL(hub).host; }
  catch { return "this hub"; }
}

function DeviceRow({ device, now, hub, busy, revoke }: {
  device: AccessDevice; now: number; hub: string | null; busy: boolean; revoke: (device: AccessDevice) => void;
}): ReactElement {
  const signedIn = formatTimestamp(device.signedInAt, now, true);
  const name = device.deviceName ?? `Unnamed device (${device.deviceId.slice(0, 8)})`;
  return <tr>
    <th className={`${CELL} max-w-56 font-normal wrap-anywhere`} scope="row">
      {device.deviceName ?? <><span className="ub-muted">Unnamed device</span>{" "}<span className="ub-muted mt-1 block font-(family-name:--font-mono) ub-type-caption" title={device.deviceId}>{device.deviceId.slice(0, 8)}</span></>}
      {device.current && <>{" "}<span className="ub-muted mt-1 block">This computer</span></>}
    </th>
    <td className={CELL}>{signedIn !== null && <time dateTime={signedIn.dateTime} title={signedIn.title}>{signedIn.label}</time>}</td>
    <td className={CELL}><AlertDialog>
      <AlertDialogTrigger asChild><button type="button" className={ROW_ACTION} disabled={busy}
        aria-label={`Revoke ${device.deviceName ?? "Unnamed device"} (${device.deviceId})`}>Revoke</button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{device.current ? "Revoke this computer?" : `Revoke ${name}?`}</AlertDialogTitle>
        <AlertDialogDescription>This one device of yours loses access to this hub. Documents already downloaded stay where they are.{device.current && ` This computer's sync with the hub stops until ub auth login ${hub ?? "<hub>"} is run again.`}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => revoke(device)}>Revoke</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog></td>
  </tr>;
}

export function DevicesSettings({ request, initial }: {
  request: (action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>;
  initial: AccessAnswer | null;
}): ReactElement {
  const [list, setList] = useState(initial);
  const [identity, setIdentity] = useState(initial?.status === "ok" ? initial : null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ applied: boolean; text: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const now = useTimestampClock();

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setFeedback(null); setBusy(false);
    return () => { controller.abort(); lifetime.current = null; };
  }, []);

  useEffect(() => {
    setList(initial);
    if (initial?.status === "ok") setIdentity(initial);
  }, [initial]);

  const safelyRequest = useCallback(async (action: AccessAction, signal: AbortSignal): Promise<AccessAnswer> => {
    try { return await request(action, signal); }
    catch { return { status: "hub-down", hub: null }; }
  }, [request]);

  const revoke = async (device: AccessDevice): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (busy || list?.status !== "ok" || signal === undefined || signal.aborted) return;
    setBusy(true); setFeedback(null);
    const result = await safelyRequest({ operation: "revoke-device", deviceId: device.deviceId }, signal);
    if (signal.aborted) return;
    const applied = result.status === "ok" || (result.status === "closure-failed" && result.applied === true);
    const success = device.current
      ? `This computer was revoked. Its sync with the hub stops until ub auth login ${identity?.hub ?? "<hub>"} is run again. Documents already downloaded stay where they are.`
      : "Device revoked. Documents already downloaded stay where they are.";
    // Keep the hub's acknowledgment when revoking this computer makes the
    // following read require a new sign-in.
    setFeedback({ applied, text: applied
      ? `${success}${result.status === "closure-failed" ? " The change was applied; the hub could not close every active connection." : ""}`
      : failure(result.status, result.hub) });
    const next = await safelyRequest({ operation: "list-devices" }, signal);
    if (signal.aborted) return;
    setList(next);
    if (next.status === "ok") setIdentity(next);
    setBusy(false);
  };

  return <section className="ub-pane ub-page-pane" data-settings-page aria-labelledby="ub-settings-title">
    <div className="ub-column gap-4">
      <div className="ub-page-header">
        <h1 id="ub-settings-title" className="ub-title">Devices</h1>
        {identity?.handle !== undefined && <p className="m-0 ub-type-small">Computers signed in to {host(identity.hub)} as @{identity.handle}. Revoking one stops its sync; its downloaded documents stay.</p>}
      </div>
      {feedback !== null && <p className="m-0 ub-type-ui" role={feedback.applied ? "status" : "alert"}>{feedback.text}</p>}
      {list === null ? <p className="m-0 ub-type-ui" role="status">Reading devices from the hub…</p> :
        list.status !== "ok" ? <p className="m-0 ub-type-ui" role="alert">{failure(list.status, list.hub)}</p> :
        list.devices?.length === 0 ? <p className="m-0 ub-type-ui">No signed-in devices.</p> :
        <div className="overflow-x-auto"><table className="w-full table-auto border-collapse" aria-label="Devices">
          <thead><tr><th className={`${CELL} ub-type-ui`} scope="col">Device</th><th className={`${CELL} ub-type-ui`} scope="col">Signed in</th><th className={`${CELL} ub-type-ui`} scope="col">Revoke</th></tr></thead>
          <tbody>{list.devices?.map((device) => <DeviceRow key={device.deviceId} device={device} now={now}
            hub={identity?.hub ?? null} busy={busy} revoke={(device) => { void revoke(device); }} />)}</tbody>
        </table></div>}
    </div>
  </section>;
}
