/** Devices belong to the hub login, independently of workspace membership. */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { AccessAction, AccessAnswer, AccessDevice } from "../../shell/workspace-access.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { CELL, ConfirmAction, FeedbackLine, ROW_HEADER, SettingsPage, TableHead, acknowledged, askHub, hubHost, loginFailure, useHubMutation } from "./settings-kit.js";

function failure(status: string, hub: string | null): string {
  switch (status) {
    case "local-only": return "Devices are available from a workspace bound to the hub you are signed in to.";
    case "forbidden": return "The hub refused access to these devices. Sign in to this hub again, then visit Devices.";
    case "device-not-found": return "The hub refused this change: that device is no longer signed in. Visit Devices again to read the current list.";
    case "protocol-mismatch":
    case "update-required": return "Update ub and the hub, restart ub open, then visit Devices again.";
    default: return loginFailure(status, hub, "visit Devices again") ?? "The hub cannot be reached. Reconnect, then visit Devices again.";
  }
}

function DeviceRow({ device, now, hub, busy, revoke }: {
  device: AccessDevice; now: number; hub: string | null; busy: boolean; revoke: (device: AccessDevice) => void;
}): ReactElement {
  const signedIn = formatTimestamp(device.signedInAt, now, true);
  const name = device.deviceName ?? `Unnamed device (${device.deviceId.slice(0, 8)})`;
  return <tr>
    <th className={`${ROW_HEADER} max-w-56`} scope="row">
      {device.deviceName ?? <><span className="ub-muted">Unnamed device</span>{" "}<span className="ub-muted mt-1 block font-(family-name:--font-mono) ub-type-caption" title={device.deviceId}>{device.deviceId.slice(0, 8)}</span></>}
      {device.current && <>{" "}<span className="ub-muted mt-1 block">This computer</span></>}
    </th>
    <td className={CELL}>{signedIn !== null && <time dateTime={signedIn.dateTime} title={signedIn.title}>{signedIn.label}</time>}</td>
    <td className={CELL}><ConfirmAction trigger="Revoke" label={`Revoke ${device.deviceName ?? "Unnamed device"} (${device.deviceId})`}
      title={device.current ? "Revoke this computer?" : `Revoke ${name}?`}
      description={`This one device of yours loses access to this hub. Documents already downloaded stay where they are.${device.current ? ` This computer's sync with the hub stops until ub auth login ${hub ?? "<hub>"} is run again.` : ""}`}
      disabled={busy} onConfirm={() => revoke(device)} /></td>
  </tr>;
}

export function DevicesSettings({ request, initial, login }: {
  request: (action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>;
  initial: AccessAnswer | null;
  login?: { handle: string; hub: string } | null;
}): ReactElement {
  const [list, setList] = useState(initial);
  const [identity, setIdentity] = useState(initial?.status === "ok" ? initial : null);
  const { busy, feedback, setFeedback, run } = useHubMutation();
  const now = useTimestampClock();
  const noteIdentity = identity ?? login;

  useEffect(() => {
    setList(initial);
    if (initial?.status === "ok") setIdentity(initial);
  }, [initial]);

  const revoke = (device: AccessDevice): void => {
    if (list?.status !== "ok") return;
    void run(async (signal) => {
      const result = await askHub(request, { operation: "revoke-device", deviceId: device.deviceId }, signal);
      if (signal.aborted) return;
      const done = acknowledged(result, device.current
        ? `This computer was revoked. Its sync with the hub stops until ub auth login ${identity?.hub ?? "<hub>"} is run again. Documents already downloaded stay where they are.`
        : "Device revoked. Documents already downloaded stay where they are.");
      // Keep the hub's acknowledgment when revoking this computer makes the
      // following read require a new sign-in.
      setFeedback({ applied: done !== null, text: done ?? failure(result.status, result.hub) });
      const next = await askHub(request, { operation: "list-devices" }, signal);
      if (signal.aborted) return;
      setList(next);
      if (next.status === "ok") setIdentity(next);
    });
  };

  return <SettingsPage title="Devices" gap="gap-4" note={noteIdentity?.handle !== undefined
    ? `Computers signed in to ${hubHost(noteIdentity.hub)} as @${noteIdentity.handle}. Revoking one stops its sync; its downloaded documents stay.` : null}>
    <FeedbackLine feedback={feedback} />
    {list === null ? <p className="m-0 ub-type-ui" role="status">Reading devices from the hub…</p> :
      list.status !== "ok" ? <p className="m-0 ub-type-ui" role="alert">{failure(list.status, list.hub)}</p> :
      list.devices?.length === 0 ? <p className="m-0 ub-type-ui">No signed-in devices.</p> :
      <div className="overflow-x-auto"><table className="w-full table-auto border-collapse" aria-label="Devices">
        <TableHead columns={["Device", "Signed in", "Revoke"]} />
        <tbody>{list.devices?.map((device) => <DeviceRow key={device.deviceId} device={device} now={now}
          hub={identity?.hub ?? null} busy={busy} revoke={revoke} />)}</tbody>
      </table></div>}
  </SettingsPage>;
}
