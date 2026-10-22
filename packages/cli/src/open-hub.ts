import { createHub, silentLogger, type Hub } from "@uberblick/hub";
import { readDeviceLogin } from "@uberblick/mcp-server/device-login";
import { hubTransportProblem, isLoopbackHost } from "@uberblick/mcp-server/remote-url";
import { usesDeviceLogin } from "@uberblick/mcp-server";
import { resolveMcpConfig } from "./budget.js";
import { resolveHubConfig } from "./hub-config.js";
import type { Io } from "./io.js";
import { whyNotStartable } from "./open-ports.js";
import { endpointOf, hubBind, probeHubState } from "./probes.js";
import { trimmed } from "./strings.js";
import { displayWorkspaceHub } from "./workspace-use-output.js";

export interface HubDecision {
  /** The hub this command started, and is therefore responsible for stopping. */
  started: Hub | null;
  note: string;
  showNote?: boolean;
  deviceHub?: boolean;
}

/**
 * Hub reachability requires authenticated directory-room access, not just TCP.
 */
export async function ensureHub(
  resolved: NodeJS.ProcessEnv,
  hubUrl: string,
  workspace: string,
  io: Io,
  verbose: boolean,
): Promise<HubDecision> {
  const endpoint = endpointOf(hubUrl);
  if (endpoint === null) {
    throw new Error(
      `the configured endpoint ${JSON.stringify(hubUrl)} is not a websocket ` +
        "endpoint — it has to be a ws:// or wss:// URL",
    );
  }
  // Preserve the scheme and explicit port for the startup eligibility check.
  const parsed = new URL(hubUrl);
  const transport = hubTransportProblem(hubUrl, resolved);
  if (transport !== null) {
    return { started: null, note: `${transport.reason}; ${transport.fix}`, showNote: true };
  }
  const displayHub = isLoopbackHost(endpoint.host) ? hubUrl : displayWorkspaceHub(hubUrl);
  const signInRequired = readDeviceLogin(hubUrl, workspace, resolved).status === "sign-in-required";
  if (usesDeviceLogin(hubUrl, resolved) && signInRequired) {
    return { started: null, note: `${displayHub} (not signed in, changes stay here)` };
  }
  if (!isLoopbackHost(endpoint.host)) {
    return { started: null, note: `${displayHub} (remote, nothing started here)` };
  }

  if (usesDeviceLogin(hubUrl, resolved)) {
    // The serving replica supplies the bounded authenticated reading below.
    return { started: null, note: `${hubUrl} (device-authenticated hub; nothing started here)`, deviceHub: true };
  }

  const secret = trimmed(resolved.HUB_AUTH_TOKEN);

  if (secret === null) {
    // Refuse startup without a signing secret; absence is distinct from downtime.
    const recovery = whyNotStartable(hubUrl, parsed) === null
      ? "free the local hub port and run `ub open` again, or export HUB_AUTH_TOKEN"
      : "export HUB_AUTH_TOKEN";
    return {
      started: null,
      showNote: true,
      note:
        `${hubUrl} (not started: no signing secret, so a hub here would accept ` +
        `anything — ${recovery})`,
    };
  }

  const probe = await probeHubState(resolveMcpConfig(resolved), hubUrl);
  if (probe.status === "connected") {
    return { started: null, note: `${hubUrl} (already running — left alone)` };
  }
  if (probe.status === "auth-failed" || probe.status === "update-required") {
    // Refused authority proves the endpoint is occupied, not permission to
    // replace its hub. Device refusal keeps its sign-in recovery wording.
    if (probe.authRecovery === "sign-in-required" && signInRequired) {
      return { started: null, note: `${displayHub} (not signed in, changes stay here)`, deviceHub: true };
    }
    return { started: null, note: `${hubUrl} (${probe.reason ?? "credential refused"}; nothing started here)`, showNote: true,
      deviceHub: probe.authRecovery !== undefined };
  }

  // Startup restrictions do not apply to a hub already answering the endpoint.
  const refusal = whyNotStartable(hubUrl, parsed);
  if (refusal !== null) {
    throw new Error(refusal);
  }

  // The hub reads HUB_HOST:PORT, not HUB_URL. Bind the dialled endpoint and
  // warn on a conflicting PORT rather than silently starting an unreachable hub.
  const bind = hubBind(resolved);
  if (bind.raw !== null && bind.port !== endpoint.port) {
    io.err(
      `ub: warning: PORT is ${JSON.stringify(bind.raw)} but the configured endpoint dials port ` +
        `${endpoint.port}; the hub started here binds ${endpoint.port}, because ` +
        "that is what the web app dials. `ub doctor` explains the two settings.\n",
    );
  }

  let hub: Hub;
  try {
    // whyNotStartable has fenced this exact dialled address to loopback.
    hub = await createHub(
      { ...resolveHubConfig({
        ...resolved,
        PORT: String(endpoint.port),
        HUB_HOST: endpoint.host,
      }), ...(!verbose ? { log: silentLogger } : {}) },
    );
  } catch (error) {
    // An occupied port after a failed auth probe has no identified holder;
    // point to doctor's local hub check rather than guessing.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `nothing at ${hubUrl} answered this machine's credential, and its port ` +
          "is held by something else, so no hub could be started for it — " +
          "`ub doctor` says what holds it",
      );
    }
    throw error;
  }
  return { started: hub, note: `${hubUrl} (started here)` };
}
