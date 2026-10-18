/**
 * Hub probes authenticate with the stored remote login or local signing secret
 * and read the directory room using the client's connect and sync budgets.
 * Keep authentication failure distinct from reachability failure for remedies.
 * Probes write no documents or bindings; renewal may replace the stored login.
 * Failures are returned as values so callers can report them.
 */

import { createServer } from "node:net";
import { DEFAULT_HOST, DEFAULT_PORT } from "@uberblick/hub/config";
import { hubTransportProblem, isLoopbackHost } from "@uberblick/mcp-server/remote-url";
import type { HubState, McpConfig } from "@uberblick/mcp-server";
import { inspectRemote } from "@uberblick/mcp-server";
import { budget } from "./budget.js";

/**
 * `unsettled` accepts the socket but misses the directory-room deadline;
 * waitForQuiet returning alone does not prove the room was read.
 */
export type HubReach = HubState["status"] | "unsettled";

/** Keep the protocol versions and locally composed reason for diagnostics. */
export type HubProbe = Omit<HubState, "status"> & { status: HubReach };

export async function probeHub(
  config: McpConfig,
  hubUrl: string = config.hubUrl,
): Promise<HubReach> {
  return (await probeHubState(config, hubUrl)).status;
}

export async function probeHubState(
  config: McpConfig,
  hubUrl: string = config.hubUrl,
): Promise<HubProbe> {
  const corpus = await inspectRemote({ ...config, hubUrl });
  const status = corpus.hub.status;
  // A connected socket without a complete directory read is not a healthy hub.
  return {
    ...corpus.hub,
    status: status === "connected" && !corpus.complete ? "unsettled" : status,
  };
}

export type PortState =
  /** Nothing holds it: the hub could bind it. */
  | "free"
  /** Something holds it. Which process it is takes a hub probe to answer. */
  | "in-use"
  /** The address could not be tested at all — a privileged port, or not ours. */
  | "unknown";

export interface PortProbe {
  host: string;
  port: number;
  state: PortState;
  /** The errno behind `unknown`, for the report. Null otherwise. */
  code: string | null;
}

/** Bind rather than dial: a silent listener still occupies the port. */
export function probePort(host: string, port: number): Promise<PortProbe> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? null;
      resolve({
        host,
        port,
        state: code === "EADDRINUSE" ? "in-use" : "unknown",
        code,
      });
    });
    // Never share a listener with another process and report the port as free.
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve({ host, port, state: "free", code: null }));
    });
  });
}

/**
 * Seconds the HTTP Date header is ahead of this machine; negative means this
 * machine is ahead, the direction the hub refuses. Null means no observation.
 * The unauthenticated greeting works before login. Use an uncached GET, while
 * remembering a terminating proxy may supply its own clock in that header.
 * Compare against the request midpoint to split round-trip uncertainty; Date
 * has only one-second resolution, so either endpoint biases threshold checks.
 */
export async function probeHubClock(
  hubUrl: string,
  timeoutMs = budget(2_000),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  let url: URL;
  try {
    if (hubTransportProblem(hubUrl, env) !== null) return null;
    url = new URL(hubUrl);
  } catch {
    return null;
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.searchParams.set("ub-clock", String(Date.now()));

  const before = Date.now();
  let header: string | null;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    header = response.headers.get("date");
    // Nothing reads the body, but an unconsumed one holds the socket open.
    await response.body?.cancel();
  } catch {
    return null;
  }
  const after = Date.now();

  if (header === null) {
    return null;
  }
  const hub = Date.parse(header);
  if (Number.isNaN(hub)) {
    return null;
  }
  return Math.round((hub - (before + after) / 2) / 1_000);
}

export interface HubBind {
  host: string;
  /** Null when `PORT` is set to something that is not a port number. */
  port: number | null;
  /** What `PORT` was set to, or null when it was not set at all. */
  raw: string | null;
}

/**
 * The hub binds HUB_HOST:PORT independently of HUB_URL; compare both sides.
 * Import its defaults so client diagnostics cannot drift from the actual bind.
 */
export function hubBind(env: NodeJS.ProcessEnv = process.env): HubBind {
  const host = env.HUB_HOST?.trim();
  const raw = env.PORT?.trim();
  if (raw === undefined || raw === "") {
    return {
      host: host === undefined || host === "" ? DEFAULT_HOST : host,
      port: DEFAULT_PORT,
      raw: null,
    };
  }
  const port = Number(raw);
  return {
    host: host === undefined || host === "" ? DEFAULT_HOST : host,
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null,
    raw,
  };
}

export interface Endpoint {
  host: string;
  port: number;
}

const SCHEME_PORTS: Record<string, number> = {
  "ws:": 80,
  "wss:": 443,
  "http:": 80,
  "https:": 443,
};

/**
 * Resolve omitted scheme ports so ws://localhost and ws://localhost:80 compare
 * as the same socket. Invalid URLs or unresolvable ports return null.
 */
export function endpointOf(hubUrl: string): Endpoint | null {
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    return null;
  }
  const port =
    parsed.port === "" ? SCHEME_PORTS[parsed.protocol] : Number(parsed.port);
  if (port === undefined || !Number.isInteger(port)) {
    return null;
  }
  // `URL` keeps an IPv6 host in brackets; every consumer here wants the address.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return { host, port };
}

export const isLocalHost = isLoopbackHost;

/**
 * Wildcard bind addresses must be dialed through loopback.
 */
export function dialHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}
