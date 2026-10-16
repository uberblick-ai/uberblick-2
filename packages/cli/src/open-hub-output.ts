import type { HubState } from "@uberblick/mcp-server";

interface HubStateSource {
  state(): HubState;
  onStateChange(listener: () => void): () => void;
}

/** Read startup reachability without extending the client's connection budget. */
export async function waitForOpenHubState(
  sync: HubStateSource,
  connectTimeoutMs: number,
): Promise<HubState> {
  const initial = sync.state();
  if (initial.status !== "connecting") return initial;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = (): void => {};
    let settled = false;
    const finish = (state: HubState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(state);
    };
    const inspect = (): void => {
      const state = sync.state();
      if (state.status !== "connecting") finish(state);
    };
    stop = sync.onStateChange(inspect);
    // The transport derives hub-down from elapsed time, without a state event.
    // At the exact deadline its strict comparison may still say connecting.
    timer = setTimeout(() => {
      const state = sync.state();
      finish(state.status === "connecting" ? { ...state, status: "hub-down" } : state);
    }, connectTimeoutMs);
    inspect();
  });
}

function refusal(state: HubState, origin: string): string | null {
  const prefix = `ub open: hub ${origin} `;
  if (state.status === "update-required") {
    return state.hubProtocolVersion !== undefined && state.hubProtocolVersion < state.protocolVersion
      ? `${prefix}runs an older Uberblick, changes stay here; ask whoever runs ${origin} to update the hub\n`
      : `${prefix}needs a newer Uberblick, changes stay here; run \`ub update\`\n`;
  }
  if (state.status !== "auth-failed") return null;
  switch (state.authRecovery) {
    case "sign-in-required":
      return `${prefix}refused this machine's sign-in, changes stay here; run \`ub auth login\`\n`;
    case "no-workspace-access":
      return `${prefix}refused workspace access, changes stay here; ask a workspace admin for access\n`;
    case "credential-store":
      return `${prefix}could not read this machine's sign-in, changes stay here; run \`ub doctor\` for details\n`;
    case "renewal-unavailable":
      return `${prefix}could not renew this machine's sign-in, changes stay here; run \`ub doctor\` for details\n`;
    default:
      return `${prefix}refused this machine's credential, changes stay here; run \`ub doctor\` for details\n`;
  }
}

export interface OpenHubMonitor {
  stop(): void;
}

/** Keep transient retries quiet while surfacing outages and actionable refusals. */
export function monitorOpenHub(
  sync: HubStateSource,
  origin: string,
  err: (text: string) => void,
  options: { unreachableAtStart?: boolean; notSignedInAtStart?: boolean } = {},
): OpenHubMonitor {
  let unreachableAnnounced = options.unreachableAtStart ?? false;
  let downSince: number | null = null;
  let outageTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRefusal = options.notSignedInAtStart
    ? refusal({ status: "auth-failed", authRecovery: "sign-in-required", protocolVersion: 0, url: null }, origin)
    : null;
  let stopped = false;
  const clearOutage = (): void => {
    downSince = null;
    clearTimeout(outageTimer);
    outageTimer = undefined;
  };
  const inspect = (): void => {
    if (stopped) return;
    const state = sync.state();
    if (state.status === "connected") {
      if (unreachableAnnounced) {
        err(`ub open: hub ${origin} reachable again, syncing local changes\n`);
      }
      unreachableAnnounced = false;
      lastRefusal = null;
      clearOutage();
      return;
    }
    const refused = refusal(state, origin);
    if (refused !== null) {
      if (refused !== lastRefusal) err(refused);
      lastRefusal = refused;
      clearOutage();
      return;
    }
    if (state.status !== "connecting" && state.status !== "hub-down") {
      clearOutage();
      return;
    }
    if (downSince === null) {
      downSince = Date.now();
      if (!unreachableAnnounced) outageTimer = setTimeout(inspect, 10_000);
    }
    if (!unreachableAnnounced && Date.now() - downSince >= 10_000) {
      err(`ub open: hub ${origin} unreachable, changes stay on this machine until it is back\n`);
      unreachableAnnounced = true;
    }
  };
  const unsubscribe = sync.onStateChange(inspect);
  // Poll too: timeout-derived hub-down has no corresponding state event.
  const interval = setInterval(inspect, 1_000);
  inspect();
  return {
    stop: () => {
      stopped = true;
      unsubscribe();
      clearInterval(interval);
      clearOutage();
    },
  };
}
