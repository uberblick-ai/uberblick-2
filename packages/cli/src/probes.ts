/**
 * Observations of the running stack: does a hub answer, and who holds a port.
 *
 * Their own module because they are observations rather than verdicts. `ub
 * doctor` turns them into checks with remedies; `ub open` will ask the same two
 * questions to decide whether it has to start a hub before opening a document.
 *
 * **The hub probe is a real client, not a socket test.** It mints a token from
 * the configured signing secret, sends it in Hocuspocus' auth message and reads
 * the workspace's directory room — the same path the MCP server and `ub remote`
 * take. So a probe that says `connected` means a client would connect, not
 * merely that something accepted a TCP connection; and `auth-failed` stays
 * distinct from `hub-down`, because one is a secret a human must fix and the
 * other is a process that is not running.
 *
 * **The port probe binds rather than dials**, because the question it answers is
 * the hub's: can `HUB_HOST`:`PORT` be bound, or is it taken. A dial cannot tell
 * a free port from one held by something that ignores connections.
 *
 * Nothing here writes anything, and nothing here throws: every failure is a
 * value, since the caller's whole job is to report failures.
 */

import { createServer } from "node:net";
import { DEFAULT_HOST, DEFAULT_PORT } from "@uberblick/hub/config";
import type { HubState, McpConfig } from "@uberblick/mcp-server";
import { inspectRemote } from "@uberblick/mcp-server";

/**
 * Dial an endpoint as a real client would and report what happened.
 *
 * Bounded by the configuration's own connect and sync budgets — the ones a
 * client uses — so what this waits for is what a client would wait for.
 */
export async function probeHub(
  config: McpConfig,
  hubUrl: string = config.hubUrl,
): Promise<HubState> {
  const corpus = await inspectRemote({ ...config, hubUrl });
  return corpus.hub;
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

/** Whether `host`:`port` can be bound right now. */
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
    // `exclusive`, so a port another process holds is reported as taken rather
    // than shared with it.
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve({ host, port, state: "free", code: null }));
    });
  });
}

export interface HubBind {
  host: string;
  /** Null when `PORT` is set to something that is not a port number. */
  port: number | null;
  /** What `PORT` was set to, or null when it was not set at all. */
  raw: string | null;
}

/**
 * The address a hub started from this environment would bind.
 *
 * Read here so a *client-side* command can say what the server side would do —
 * which is the whole content of the port-disagreement failure: the hub binds
 * `HUB_HOST`:`PORT` and never parses `HUB_URL`, so the two are only ever kept
 * in step by whoever sets them. The defaults come from the hub's own module
 * rather than being restated, because a restated default is one that can drift.
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

/** The default ports the two websocket schemes carry when a URL omits one. */
const SCHEME_PORTS: Record<string, number> = {
  "ws:": 80,
  "wss:": 443,
  "http:": 80,
  "https:": 443,
};

/**
 * The host and port a `HUB_URL` dials, or null when it is not a URL at all.
 *
 * The port is resolved rather than reported as written: `ws://localhost` and
 * `ws://localhost:80` dial the same socket, and a check comparing ports must
 * not call them different.
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

/** Hosts that name this machine — the only ones a local hub could be bound to. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "::1",
  "0.0.0.0",
  "::",
  "[::]",
]);

/**
 * Whether an endpoint could be served by a hub on this machine.
 *
 * The port checks are about a hub *here*; a `HUB_URL` naming somebody else's
 * host has no local `PORT` to disagree with, and probing a remote address would
 * answer a question nobody asked.
 */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || /^127\./.test(host);
}

/**
 * The address to dial to reach a hub bound to `host`.
 *
 * A wildcard bind is an address to listen on, never one to connect to: a hub on
 * `0.0.0.0` is reached over loopback like any other local process.
 */
export function dialHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}
