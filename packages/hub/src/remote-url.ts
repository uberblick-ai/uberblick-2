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

/**
 * The path the deployed stack serves the hub under (REMOTE.md).
 *
 * The one deployment convention this CLI encodes, by the owner's decision, and
 * it is applied only where a scheme had to be invented — see below.
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
 * Read an endpoint from whatever form of it somebody has to hand, or refuse.
 *
 * Three forms, because three are what people actually hold: the host name
 * `tailscale status` prints, the `https://…` address a browser's bar hands
 * back, and a websocket endpoint somebody already knows in full. The first two
 * name the deployment REMOTE.md stands up, which serves the hub at
 * `wss://<host>/ws`, so they are read as it rather than refused with a lecture
 * — and `http://` likewise, to `ws://`, since a plaintext address means a
 * plaintext hub.
 *
 * Userinfo, query and fragment are refused rather than carried. A hub token
 * travels in Hocuspocus' auth message and never in the URL, by invariant, so
 * `wss://user:secret@host/ws?token=…` is at best a misunderstanding and at
 * worst a credential this command would persist into two files and echo back
 * on stdout. **No refusal here repeats the value**, for the same reason: the
 * one that fails to parse is exactly the one somebody may have pasted a secret
 * into, so the message describes the shape that is expected instead.
 */
function readRemoteUrl(value: string): RemoteUrl {
  const text = value.trim();
  // Read from the text, not from what the parser makes of it: `new URL` reads
  // `localhost:1234` as a scheme with a path, so a bare host with a port would
  // otherwise be understood as something else entirely.
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
 * The endpoint to store, built back from its pieces.
 *
 * The deployed path fills in for a path nobody gave — but only where the scheme
 * was invented too, which is the whole of what that convenience buys. An
 * endpoint somebody typed in full names its own path, empty included.
 */
function formatRemoteUrl(url: RemoteUrl, path = url.path): string {
  return `${url.scheme}://${url.host}${path === "" && url.invented ? DEPLOYED_PATH : path}`;
}

/**
 * The endpoint to store, from whatever form of it somebody typed.
 *
 * A `ws://` or `wss://` endpoint comes back **exactly as typed**: it is what
 * somebody who knows their hub wrote down, and rebuilding it through `URL`
 * would fold the host's case, drop an explicit `:443` and eat a trailing slash
 * — three silent rewrites of a value this then stores and compares against on
 * every later run. Only an invented scheme produces a rewritten string, because
 * there the whole point is to produce one.
 */
export function normalizeRemoteUrl(value: string): string {
  const url = readRemoteUrl(value);
  return url.invented ? formatRemoteUrl(url) : url.text;
}

/**
 * The two things a join URL carries: where the hub is, and which workspace.
 *
 * The form is an endpoint with the workspace id as its **last path segment** —
 * `wss://hub.example.ts.net/ws/<workspace-id>` — and `ub workspace promote` prints
 * exactly that. One string is the whole of what a second machine has to be
 * told, which is the point: an id copied separately is an id copied wrongly,
 * and a machine that invents its own joins a hub and finds nothing of yours on
 * it, because the rooms are keyed by a different id.
 *
 * The id's grammar belongs to schema — a uuid, optionally slug-decorated — and
 * is not restated here. The spelling is kept as typed, the way `ub workspace
 * use` keeps it; only what reaches a room, a token or the database filename is
 * the bare uuid. Everything before the last segment is an ordinary endpoint and
 * goes through the same reader {@link normalizeRemoteUrl} uses, so a credential
 * smuggled into the URL is refused there rather than in two places — and a bare
 * host or an `https://` address gets the deployed path here too, since the id
 * is removed *before* the endpoint is built rather than after.
 *
 * Neither refusal echoes the URL back. `ub workspace promote` prints this string and
 * people paste it about, so the actionable half is the *form*, and repeating a
 * value somebody may have put a secret into is how it reaches a terminal log.
 */
export function parseJoinTarget(value: string): {
  endpoint: string;
  workspace: string;
} {
  const url = readRemoteUrl(value);
  // The last segment and its own separator; everything before them is the
  // endpoint, **verbatim**. Splitting the path and rejoining the non-empty
  // parts would rewrite it — `/proxy//ws/<id>` would come back as `/proxy/ws`
  // — and an empty segment is somebody's reverse proxy path, which may well
  // route differently from the tidied version. Only the id is this command's
  // to remove. A path of "" leaves an empty workspace, which is the refusal
  // below rather than a special case.
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
  // Everything the id's segment leaves behind. An endpoint somebody typed in
  // full is cut out of the string they typed, so the half that is stored is
  // byte for byte the half they wrote — `wss://Host:443/ws/<id>` keeps its
  // case, its explicit port and its path, none of which survive a rebuild
  // through `URL`. An invented form has no spelling to preserve: it is rebuilt,
  // and a path left as nothing but a root slash (`https://host//<id>`) collapses
  // so that it takes the deployed path like every other invented form.
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
