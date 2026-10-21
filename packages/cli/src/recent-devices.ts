import { readDeviceLogin, sameCredential } from "@uberblick/mcp-server/device-login";
import { manageRequest, sanitizeManagementReply } from "@uberblick/mcp-server/management-client";
import { timeAgo } from "./strings.js";

export interface RecentDevice {
  id: string;
  name?: string;
  signedInAt: string;
}

export interface RecentDeviceReading {
  devices: RecentDevice[];
  hubVersion: string | null;
}

interface DeviceBinding {
  hubUrl: string | null;
  workspaceId: string;
  env: NodeJS.ProcessEnv;
}

/** An account-scoped reading, with no renewal, acknowledgement or stored state. */
export async function requestRecentDevices(binding: DeviceBinding, signal: AbortSignal): Promise<RecentDeviceReading | null> {
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
    if (latest.status !== "ready" || !sameCredential(latest.login, current.login)) return null;
    const now = Date.now();
    const devices = reply.body.devices as { deviceId: string; deviceName?: string; signedInAt: number; current: boolean }[];
    return {
      devices: devices.filter(device => !device.current && device.signedInAt >= now - 7 * 86_400_000 && device.signedInAt <= now)
        .map(device => ({ id: device.deviceId, ...(device.deviceName === undefined ? {} : { name: device.deviceName }),
          signedInAt: new Date(device.signedInAt).toISOString() })),
      hubVersion: typeof reply.body.hubVersion === "string" ? reply.body.hubVersion : null,
    };
  } catch {
    // Store and transport failures must not add a problem or expose private diagnostics.
    return null;
  }
}

export function recentDevicesNotice(devices: RecentDevice[] | null, origin: string): string {
  return (devices ?? []).map(device =>
    `new device  ${device.name ?? "Unnamed device"} (${device.id.slice(0, 8)}), signed in ${timeAgo(device.signedInAt)}\n` +
    "              → revoke in user menu → Devices\n" +
    `              → or ub auth logout --all-devices ${origin}\n`,
  ).join("");
}
