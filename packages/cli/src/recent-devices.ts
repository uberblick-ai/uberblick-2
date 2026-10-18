import { readDeviceLogin } from "@uberblick/mcp-server/device-login";
import { manageRequest, sanitizeManagementReply } from "@uberblick/mcp-server/management-client";

export interface RecentDevice {
  id: string;
  name?: string;
  signedInAt: string;
}

interface DeviceBinding {
  hubUrl: string | null;
  workspaceId: string;
  env: NodeJS.ProcessEnv;
}

/** An account-scoped reading, with no renewal, acknowledgement or stored state. */
export async function requestRecentDevices(binding: DeviceBinding, signal: AbortSignal): Promise<RecentDevice[] | null> {
  if (binding.hubUrl === null) return null;
  try {
    signal.throwIfAborted();
    const current = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (current.status !== "ready") return null;
    const action = { operation: "list-devices" } as const;
    const reply = sanitizeManagementReply(action,
      await manageRequest(current.origin, action, current.login, { signal }), current.login);
    if (reply.status !== 200 || reply.body.status !== "ok") return null;
    const latest = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (latest.status !== "ready" || latest.login.credential.record.id !== current.login.credential.record.id ||
        latest.login.credential.key !== current.login.credential.key) return null;
    const now = Date.now();
    const devices = reply.body.devices as { deviceId: string; deviceName?: string; signedInAt: number; current: boolean }[];
    return devices.filter(device => !device.current && device.signedInAt >= now - 7 * 86_400_000 && device.signedInAt <= now)
      .map(device => ({ id: device.deviceId, ...(device.deviceName === undefined ? {} : { name: device.deviceName }),
        signedInAt: new Date(device.signedInAt).toISOString() }));
  } catch {
    // Store and transport failures must not add a problem or expose private diagnostics.
    return null;
  }
}

function signInAge(time: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 1_000));
  if (seconds < 5) return "just now";
  for (const [unit, duration] of [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]] as const) {
    if (seconds >= duration) {
      const count = Math.floor(seconds / duration);
      return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export function recentDevicesNotice(devices: RecentDevice[] | null, origin: string): string {
  return (devices ?? []).map(device =>
    `new device  ${device.name ?? "Unnamed device"} (${device.id.slice(0, 8)}), signed in ${signInAge(device.signedInAt)}\n` +
    "              → revoke in user menu → Devices\n" +
    `              → or ub auth logout --all-devices ${origin}\n`,
  ).join("");
}
