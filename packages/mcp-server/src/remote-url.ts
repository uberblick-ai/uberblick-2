import { parseWorkspaceId } from "@uberblick/schema";
import { isLoopbackHost } from "@uberblick/schema/loopback";
export { isLoopbackHost } from "@uberblick/schema/loopback";

/** Wildcards and unrecognized host spellings always require device login. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try { return isLoopbackHost(new URL(endpoint).hostname); }
  catch { return false; }
}

/** A value carrying its own scheme, as opposed to a bare host. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Default deployment path only for bare hosts or HTTP(S) forms without a path.
 */
const DEPLOYED_PATH = "/ws";

/** An endpoint, read and validated, in the pieces both callers below need. */
interface RemoteUrl {
  /** Exactly what was typed, trimmed. */
  text: string;
  scheme: "ws" | "wss";
  host: string;
  /** The path, or "" where none was given. */
  path: string;
  /** Whether the scheme was invented here — a bare host or a web address. */
  invented: boolean;
}

/**
 * Bare hosts default to WSS; HTTP(S) maps to WS(S). Refuse userinfo, query and
 * fragment: credentials belong in authentication frames, never persisted URLs.
 * No refusal may echo potentially secret input.
 */
function readRemoteUrl(value: string): RemoteUrl {
  const text = value.trim();
  // Detect schemes before URL parsing, which treats `localhost:1234` as one.
  const invented = !SCHEME.test(text);
  let url: URL;
  try {
    url = new URL(invented ? `wss://${text}` : text);
  } catch {
    throw new Error(
      "that is not a URL. The hub speaks websockets, so an endpoint looks " +
        "like wss://hub.example.ts.net/ws — a bare hub.example.ts.net, or its " +
        "https:// address, is read as one",
    );
  }
  const websocket = url.protocol === "ws:" || url.protocol === "wss:";
  const web = url.protocol === "http:" || url.protocol === "https:";
  if (!websocket && !web) {
    throw new Error(
      "that is not a websocket endpoint: it must start with ws:// or wss://, " +
        "or be a bare host or an https:// address",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "an endpoint must not carry a username or password. The hub is " +
        "authenticated in the connection's auth message, never in the URL — " +
        "run `ub auth login` for a remote hub",
    );
  }
  if (url.search !== "") {
    throw new Error(
      "an endpoint must not carry a query string. Nothing reads one, and a " +
        "token put there would be persisted and printed — run `ub auth login` " +
        "for a remote hub instead",
    );
  }
  if (url.hash !== "") {
    throw new Error("an endpoint must not carry a fragment; nothing reads one");
  }
  return {
    text,
    scheme: url.protocol === "wss:" || url.protocol === "https:" ? "wss" : "ws",
    host: url.host,
    path: url.pathname === "/" ? "" : url.pathname,
    invented: invented || web,
  };
}

/**
 * Invented forms get the deployment path only when no path was supplied.
 * Explicit WebSocket endpoints keep their own path, including an empty one.
 */
function formatRemoteUrl(url: RemoteUrl, path = url.path): string {
  return `${url.scheme}://${url.host}${path === "" && url.invented ? DEPLOYED_PATH : path}`;
}

/**
 * Keep explicit WebSocket spelling after trimming; rebuilding through URL would
 * alter host case, default ports and trailing slashes used in later comparisons.
 */
export function normalizeRemoteUrl(value: string): string {
  const url = readRemoteUrl(value);
  return url.invented ? formatRemoteUrl(url) : url.text;
}

/** Canonical WebSocket target for comparisons and admission keys, never display. */
export function hubIdentity(endpoint: string): string {
  return new URL(normalizeRemoteUrl(endpoint)).href;
}

/** Validate before composing a diagnostic, without changing stored origins. */
export function hubTransportProblem(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): { reason: string; fix: string } | null {
  const normalized = normalizeRemoteUrl(endpoint);
  const url = new URL(normalized);
  if (url.protocol === "wss:" || isLoopbackHost(url.hostname)) return null;
  const authority = `${url.hostname}:${url.port || "80"}`;
  if (env.UB_INSECURE_HUBS?.split(",").some(entry => entry.trim() === authority)) return null;
  // Parse after changing scheme to retain an explicit cleartext default port.
  const secure = new URL(endpoint.trim().replace(/^http:/i, "https:").replace(/^ws:/i, "wss:")).href;
  return {
    reason: "refusing an unencrypted connection to a hub on another computer",
    fix: `use ${secure}`,
  };
}

export function assertHubTransport(endpoint: string, env: NodeJS.ProcessEnv = process.env): void {
  const problem = hubTransportProblem(endpoint, env);
  if (problem !== null) throw new Error(`${problem.reason}; ${problem.fix}`);
}

/**
 * Read the schema-validated workspace id from the last path segment, retaining
 * its decorated spelling. Use the shared endpoint validation and never echo
 * rejected URLs; remove the id before applying an invented form's default path.
 */
export function parseJoinTarget(value: string): {
  endpoint: string;
  workspace: string;
} {
  const url = readRemoteUrl(value);
  // Cut only the final separator and id; repeated path separators may route
  // differently through a reverse proxy and must survive. Empty ids refuse.
  const cut = url.path.lastIndexOf("/");
  const workspace = url.path.slice(cut + 1);
  if (workspace === "") {
    throw new Error(
      "that URL names no workspace. A join URL is the endpoint with the " +
        "workspace id as its last path segment and nothing after it, like " +
        "wss://hub.example.ts.net/ws/<workspace-id> — `ub workspace promote` prints " +
        "it, and `ub status` on the first machine names the id",
    );
  }
  try {
    parseWorkspaceId(workspace);
  } catch {
    throw new Error(
      "the last path segment of that URL is not a workspace id: it must be a " +
        "uuid, or <slug>-<uuid>. A join URL looks like " +
        "wss://hub.example.ts.net/ws/<workspace-id> — `ub workspace promote` prints it",
    );
  }
  // Slice explicit endpoints verbatim to retain case, port and path. Invented
  // forms collapse a leftover root slash to use the deployment default.
  const suffix = `/${workspace}`;
  const path = url.path.slice(0, cut);
  const endpoint =
    url.invented || !url.text.endsWith(suffix)
      ? formatRemoteUrl(url, path === "/" ? "" : path)
      : url.text.slice(0, -suffix.length);
  return { endpoint, workspace };
}

/** Canonical identity for login storage, without rewriting a binding. */
export function authenticationOrigin(hub: string): string {
  const url = new URL(hubIdentity(hub));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}
