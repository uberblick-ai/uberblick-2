import { parseWorkspaceId } from "@uberblick/schema";
import { isLoopbackHost } from "./loopback.js";
export { isLoopbackHost } from "./loopback.js";

/** Wildcards and unrecognized host spellings always require device login. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try { return isLoopbackHost(new URL(endpoint).hostname); }
  catch { return false; }
}

/** A value carrying its own scheme, as opposed to a bare host. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** REMOTE.md's deployed path; fill it only when inventing a scheme and no path was supplied. */
const DEPLOYED_PATH = "/ws";

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
 * Accept bare hosts, HTTP(S) addresses and WS(S) endpoints; preserve plaintext
 * http/ws intent. Refuse userinfo, queries and fragments without echoing input:
 * authentication belongs in the auth message, and pasted URLs may contain secrets.
 */
function readRemoteUrl(value: string): RemoteUrl {
  const text = value.trim();
  // Detect schemes before parsing: URL treats bare localhost:1234 as a scheme.
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

/** Invented schemes get the default path; explicit websocket endpoints own even an empty path. */
function formatRemoteUrl(url: RemoteUrl, path = url.path): string {
  return `${url.scheme}://${url.host}${path === "" && url.invented ? DEPLOYED_PATH : path}`;
}

/** Preserve explicit WS(S) spelling after trimming; URL reconstruction changes case, ports and slashes. */
export function normalizeRemoteUrl(value: string): string {
  const url = readRemoteUrl(value);
  return url.invented ? formatRemoteUrl(url) : url.text;
}

/**
 * Split endpoint/<workspace-id>, retaining the schema-validated ID's spelling;
 * rooms, tokens and database filenames use its bare UUID. Shared endpoint parsing
 * refuses secret-bearing URLs without echoing them. Remove the ID before applying
 * any invented endpoint's deployed path.
 */
export function parseJoinTarget(value: string): {
  endpoint: string;
  workspace: string;
} {
  const url = readRemoteUrl(value);
  // Remove only the final segment: repeated slashes can affect proxy routing.
  // Empty paths yield an empty workspace and use the same refusal below.
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
  // Slice explicit endpoints verbatim to retain case, port and path. Rebuild
  // invented forms, collapsing a remaining root slash to the deployed default.
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
  const url = new URL(normalizeRemoteUrl(hub));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}
