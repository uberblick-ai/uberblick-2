/**
 * Runtime configuration is served by the same origin at HUB_CONFIG_PATH.
 * Keep its path and keys aligned with Caddy, dev-config-document.ts and ub open:
 *
 *     {"hubUrl": "wss://host/ws", "workspaces": ["uberblick-<uuid>", "<uuid>"],
 *      "hubAuthToken": "<token-signing key>",
 *      "remoteHubUrl": "wss://team-host/ws", "rebound": true,
 *      "defaultPresenceName": "Ana Lopez",
 *      "servedWorkspaces": {"<uuid>": {"remoteHubUrl": "wss://team-host/ws"}}}
 *
 * ub open supplies its loopback hubUrl, upstream remoteHubUrl and rebound flag;
 * rebound means the startup binding changed and the serving process needs a
 * restart. servedWorkspaces uses bare UUIDs and carries no key: its pages ask
 * ub open for room tokens with their session (collab/local-session.ts).
 * A null upstream means local-only; the top-level fields describe startup.
 * Unbound serving supplies no workspace or key. Only ub open supplies the
 * default presence name, from git user.name or the OS username; other routes
 * retain random tab names.
 *
 * Endpoints must be ws/wss URLs without userinfo, query or fragment. workspaces
 * is an ordered array or comma-separated string; its first entry answers `/`.
 * Plain duplicate keys refuse the document. This best-effort check supplements
 * the deploy wrapper's refusal of substitutions that could close a JSON string.
 *
 * Remote hosts supply no signing secret or device credential; browser access
 * requires ub auth login and ub open. Loopback development supplies its local
 * signing secret. A bundle must never contain a key. Missing keys disable
 * authentication and are not memoised, so later connects retry the document.
 *
 * Hub addresses are hardcoded only in two fallbacks: the development resolver's
 * build default and FALLBACK_HUB_URL for loading without a Vite define.
 * The served document takes precedence; diagnostics retain the source.
 * Hub release bundles disable endpoint and workspace fallbacks entirely.
 */

import { isLoopbackEndpoint } from "@uberblick/mcp-server/remote-url";
import { parseWorkspaceId, validateWorkspaceName } from "@uberblick/schema";

// Injected as string literals at build time. Declared, never imported.
declare const __RUNTIME_CONFIG_ONLY__: boolean;
declare const __HUB_URL__: string;
declare const __WORKSPACE_ID__: string;
declare const __WORKSPACES__: string;

/** Fallback used only when this module is loaded outside a Vite build. */
const FALLBACK_HUB_URL = "ws://localhost:1234";

/** Same-origin JSON; serve no-store so retargeting cannot reuse an old hub. */
export const HUB_CONFIG_PATH = "/uberblick-config.json";

/** Which of the three sources supplied a value actually in use. */
export type ConfigSource = "document" | "define" | "fallback";

export interface ClientConfig {
  /** Optional ub open default; other serving routes leave names random. */
  defaultPresenceName?: string;
  /** The hub this session dials. */
  hubUrl: string;
  hubUrlSource: ConfigSource;
  /**
   * Ordered configured spellings; the first answers `/`, empty means no menu.
   * Preserve decorations for display. Validate document entries here, but leave
   * define entries to parseRoute so invalid builds reach the invalid-ID screen.
   */
  workspaces: readonly string[];
  /** No `"fallback"`: there is no in-code workspace, only a build without one. */
  workspacesSource: "document" | "define";
  /** Document-only loopback development signing secret; empty exposes tokenMissing. */
  hubAuthToken: string;
  /** Same-document workspace/upstream pair; never attribute a fallback workspace to ub open. */
  localServing: LocalServing | null;
  /** Exact local-serving admission map; absent for legacy/dev documents. */
  servedWorkspaces?: Readonly<Record<string, ServedWorkspace>>;
}

export interface ServedWorkspace extends LocalServing {
  /** Name read from this machine's replica without taking its serving role. */
  name: string | null;
}

/** The startup binding `ub open` keeps serving until it is restarted. */
export interface LocalServing {
  workspace: string | null;
  remoteHubUrl: string | null;
  rebound: boolean;
}

/** Keep the dialled endpoint's source so diagnostics identify compiled fallbacks. */
export interface HubEndpoint {
  /** The address, or null when the configured value is not one — see {@link endpointLabel}. */
  url: string | null;
  source: ConfigSource;
}

/**
 * Display only ws/wss scheme, host and path: build defines may contain secrets.
 * Reconstruct parts to strip userinfo, query and fragment; opaque schemes could
 * otherwise leak their payload through pathname. Invalid addresses return null.
 * Omit the parser-added lone `/` so equivalent bare hosts have one label.
 */
export function endpointLabel(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** Non-document labels name the unused config path to explain fallback routing. */
export function endpointSourceLabel(source: ConfigSource): string {
  switch (source) {
    case "document":
      return `served ${HUB_CONFIG_PATH}`;
    case "define":
      return `compiled default, ${HUB_CONFIG_PATH} not used`;
    case "fallback":
      return `in-code default, ${HUB_CONFIG_PATH} not used`;
  }
}

/** Test define presence, not equality with the fallback, to report its source truthfully. */
const RUNTIME_CONFIG_ONLY = typeof __RUNTIME_CONFIG_ONLY__ === "boolean" && __RUNTIME_CONFIG_ONLY__;
const BUILT_IN_HUB_URL: Pick<ClientConfig, "hubUrl" | "hubUrlSource"> =
  RUNTIME_CONFIG_ONLY
    ? { hubUrl: "", hubUrlSource: "fallback" }
    : typeof __HUB_URL__ === "string" && __HUB_URL__ !== ""
    ? { hubUrl: __HUB_URL__, hubUrlSource: "define" }
    : { hubUrl: FALLBACK_HUB_URL, hubUrlSource: "fallback" };

/**
 * WORKSPACE_ID precedes the menu; both are fallbacks behind the served document.
 * Remove repeated spellings here; workspaceList deduplicates by parsed UUID.
 */
const BUILT_IN_WORKSPACES: readonly string[] = RUNTIME_CONFIG_ONLY ? [] : [
  ...new Set(
    [
      typeof __WORKSPACE_ID__ === "string" ? __WORKSPACE_ID__ : "",
      ...(typeof __WORKSPACES__ === "string" ? __WORKSPACES__ : "").split(","),
    ]
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  ),
];

const BUILT_IN: ClientConfig = {
  ...BUILT_IN_HUB_URL,
  workspaces: BUILT_IN_WORKSPACES,
  workspacesSource: "define",
  // Signing keys come only from the runtime document.
  hubAuthToken: "",
  localServing: null,
};

/** Refuse malformed/non-ws endpoints and credential-bearing URLs before dialing or logging. */
function usableEndpoint(
  value: string,
  key: "hubUrl" | "remoteHubUrl" = "hubUrl",
): { url: string } | { rejected: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { rejected: `${key} is not an absolute URL` };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { rejected: `${key} is not a ws:// or wss:// URL` };
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return { rejected: `${key} carries credentials (userinfo, query or fragment)` };
  }
  // Normalize whitespace the URL parser accepts but the socket may reject.
  return { url: parsed.href };
}

/**
 * Accept arrays or comma-separated strings for Caddy's environment substitution.
 * Drop invalid IDs and report only their count; never echo configured values.
 */
function usableWorkspaces(
  value: unknown,
): { list: string[]; dropped: number } | { rejected: string } {
  if (value === undefined) return { rejected: "it lists no workspaces" };
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (entries === null) {
    return { rejected: "its workspaces is neither a list nor a string" };
  }
  const list: string[] = [];
  let dropped = 0;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      dropped += 1;
      continue;
    }
    const id = entry.trim();
    // Empty string entries are formatting; count all other invalid entries.
    if (id === "") continue;
    try {
      parseWorkspaceId(id);
      list.push(id);
    } catch {
      dropped += 1;
    }
  }
  if (list.length === 0) {
    return { rejected: "none of its workspaces is a workspace id" };
  }
  return { list, dropped };
}

/** Each key of the document, read on its own — see {@link readDocument}. */
interface DocumentConfig {
  defaultPresenceName?: string;
  hubUrl: { url: string } | { rejected: string };
  workspaces: { list: string[]; dropped: number } | { rejected: string };
  /** Empty when the document named no usable token-signing key. */
  hubAuthToken: string;
  localServing: LocalServing | { rejected: string } | null;
  servedWorkspaces?: Readonly<Record<string, ServedWorkspace>>;
  servedWorkspacesRejected?: string;
}

/** Invalid local maps deny admission rather than falling back to the legacy key. */
function usableServedWorkspaces(
  value: unknown,
  workspaces: DocumentConfig["workspaces"],
  rebound: boolean,
): { map: Record<string, ServedWorkspace>; rejected?: string } {
  const map: Record<string, ServedWorkspace> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value) || "rejected" in workspaces) {
    return { map, rejected: "servedWorkspaces is not a usable local-serving map" };
  }
  const offered = new Map(workspaces.list.map((segment) => [parseWorkspaceId(segment).uuid, segment]));
  const startup = workspaces.list[0];
  const startupUuid = startup === undefined ? null : parseWorkspaceId(startup).uuid;
  let invalid = false;
  for (const [uuid, entryValue] of Object.entries(value)) {
    if (!offered.has(uuid) || entryValue === null || typeof entryValue !== "object" || Array.isArray(entryValue)) {
      invalid = true;
      continue;
    }
    const entry = entryValue as Record<string, unknown>;
    const remote = entry.remoteHubUrl === null ? null : typeof entry.remoteHubUrl === "string"
      ? usableEndpoint(entry.remoteHubUrl, "remoteHubUrl") : { rejected: "invalid upstream" };
    if (remote !== null && "rejected" in remote) {
      invalid = true;
      continue;
    }
    map[uuid] = {
      workspace: offered.get(uuid) ?? uuid,
      remoteHubUrl: remote?.url ?? null,
      rebound: rebound && uuid === startupUuid,
      name: usableWorkspaceName(entry.name),
    };
  }
  return { map, ...(invalid ? { rejected: "servedWorkspaces contains an unusable entry" } : {}) };
}

function usableWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return validateWorkspaceName(value); }
  catch { return null; }
}

/**
 * Non-200, non-JSON and non-object responses share one document-level refusal:
 * SPA fallbacks can answer missing configuration with the app's HTML and 200.
 * Endpoint and workspace fields fail independently; ignore extra keys so an
 * extended document cannot strand existing bundles. Never quote response bodies
 * or rejected values in diagnostics: either could contain a credential.
 */
function readDocument(
  status: number,
  contentType: string,
  body: string,
): DocumentConfig | { rejected: string } {
  if (status !== 200) {
    return { rejected: `it answered ${status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Report content type without exposing an HTML fallback's body.
    const said = contentType === "" ? "no content type" : contentType;
    return { rejected: `it is not JSON (content type: ${said})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rejected: "it is not a JSON object" };
  }
  // Best-effort duplicate-key defense for plain spellings. Escaped keys can
  // pass; bin/remote-compose.sh supplies the guarantee by rejecting substitutions
  // with quotes or backslashes. Attacker-controlled documents are outside it.
  // Match a key's unescaped opening quote and colon, never opaque string values.
  const document = parsed as Record<string, unknown>;
  // Nested workspace upstreams are expected occurrences, not duplicate keys.
  const nestedUpstreams = document.servedWorkspaces !== null && typeof document.servedWorkspaces === "object"
    ? Object.values(document.servedWorkspaces).filter((entry) => entry !== null && typeof entry === "object" && Object.hasOwn(entry, "remoteHubUrl")).length
    : 0;
  const twice = [
    "hubUrl",
    "workspaces",
    "hubAuthToken",
    "remoteHubUrl",
    "rebound",
    "servedWorkspaces",
    "defaultPresenceName",
  ].find(
    (key) => (body.match(new RegExp(`(^|[^\\\\])"${key}"\\s*:`, "g")) ?? []).length >
      (key === "remoteHubUrl" ? nestedUpstreams + (Object.hasOwn(document, key) ? 1 : 0) : 1),
  );
  if (twice !== undefined) {
    return { rejected: `it names ${twice} more than once` };
  }
  const url = document.hubUrl;
  const secret = document.hubAuthToken;
  const workspaces = usableWorkspaces(document.workspaces);
  const remote = document.remoteHubUrl;
  const remoteHubUrl =
    remote === undefined
      ? null
      : typeof remote === "string" && remote !== ""
        ? usableEndpoint(remote, "remoteHubUrl")
        : { rejected: "remoteHubUrl is not a non-empty string" };
  const served = Object.hasOwn(document, "servedWorkspaces")
    ? usableServedWorkspaces(document.servedWorkspaces, workspaces, document.rebound === true)
    : null;
  return {
    ...(typeof document.defaultPresenceName === "string" && document.defaultPresenceName.trim() !== ""
      ? { defaultPresenceName: document.defaultPresenceName.trim() } : {}),
    hubUrl:
      typeof url === "string" && url !== ""
        ? usableEndpoint(url)
        : { rejected: "it has no string hubUrl" },
    workspaces,
    // Refuse non-string keys without coercion or diagnostics; expose tokenMissing only.
    hubAuthToken: typeof secret === "string" ? secret.trim() : "",
    localServing:
      remoteHubUrl === null || "rejected" in remoteHubUrl
        ? remoteHubUrl
        : {
            remoteHubUrl: remoteHubUrl.url,
            workspace: "rejected" in workspaces ? null : (workspaces.list[0] ?? null),
            rebound: document.rebound === true,
          },
    ...(served === null ? {} : { servedWorkspaces: served.map, servedWorkspacesRejected: served.rejected }),
  };
}

/** Room acquisition waits on this read; bound hangs in both headers and body. */
export const HUB_CONFIG_TIMEOUT_MS = 3_000;

/**
 * Always settle: document, then defines, then in-code fallback. Release bundles
 * have no endpoint fallback; retain the rejection reason for diagnostics.
 */
export async function readClientConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = HUB_CONFIG_TIMEOUT_MS,
): Promise<ClientConfig & { rejected?: string }> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let status: number;
  let contentType: string;
  let body: string;
  try {
    const response = await fetchImpl(HUB_CONFIG_PATH, {
      // Bypass caches after deployment retargeting.
      cache: "no-store",
      // Vite can answer 404 for JSON; Caddy may still return fallback HTML.
      headers: { Accept: "application/json" },
      // The deadline also aborts a stalled response body.
      signal: deadline,
    });
    status = response.status;
    contentType = response.headers.get("content-type") ?? "";
    body = await response.text();
  } catch (error) {
    if (deadline.aborted) {
      return { ...BUILT_IN, rejected: `it did not answer within ${timeoutMs}ms` };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { ...BUILT_IN, rejected: `it could not be fetched (${reason})` };
  }

  const outcome = readDocument(status, contentType, body);
  if ("rejected" in outcome) return { ...BUILT_IN, rejected: outcome.rejected };

  const notes: string[] = [];
  if ("rejected" in outcome.hubUrl) notes.push(outcome.hubUrl.rejected);
  if ("rejected" in outcome.workspaces) notes.push(outcome.workspaces.rejected);
  else if (outcome.workspaces.dropped > 0) {
    const dropped = outcome.workspaces.dropped;
    notes.push(
      `${dropped} of its workspaces ${dropped === 1 ? "is not a workspace id" : "are not workspace ids"}`,
    );
  }
  if (outcome.localServing !== null && "rejected" in outcome.localServing) {
    notes.push(outcome.localServing.rejected);
  }
  if (outcome.servedWorkspacesRejected !== undefined) notes.push(outcome.servedWorkspacesRejected);

  const endpoint = "rejected" in outcome.hubUrl
    ? BUILT_IN_HUB_URL
    : { hubUrl: outcome.hubUrl.url, hubUrlSource: "document" as const };
  return {
    ...endpoint,
    ...(outcome.defaultPresenceName === undefined ? {} : { defaultPresenceName: outcome.defaultPresenceName }),
    ...("rejected" in outcome.workspaces
      ? { workspaces: BUILT_IN_WORKSPACES, workspacesSource: "define" as const }
      : { workspaces: outcome.workspaces.list, workspacesSource: "document" as const }),
    // Development may supply only its key and use the compiled loopback
    // endpoint. A stale deployed document cannot restore remote access.
    hubAuthToken: isLoopbackEndpoint(endpoint.hubUrl)
      ? outcome.hubAuthToken
      : "",
    localServing:
      outcome.localServing === null || "rejected" in outcome.localServing
        ? null
        : outcome.localServing,
    ...(outcome.servedWorkspaces === undefined ? {} : {
      servedWorkspaces: isLoopbackEndpoint(endpoint.hubUrl) ? outcome.servedWorkspaces : {},
    }),
    ...(notes.length === 0 ? {} : { rejected: notes.join("; ") }),
  };
}

let resolved: ClientConfig | null = null;
let pending: Promise<ClientConfig> | null = null;

/**
 * Share one configuration read across startup and room acquisition. Do not
 * memoise an answer without a signing key or a ub open map: every connect
 * retries under the same deadline, so a late-starting server can recover.
 */
export function resolveClientConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ClientConfig> {
  pending ??= readClientConfig(fetchImpl).then(({ rejected, ...config }) => {
    resolved = config;
    if (config.hubAuthToken === "" && config.servedWorkspaces === undefined) pending = null;
    // Name sources and refusal together so missing config differs from hub failure.
    const say = rejected === undefined ? console.info : console.warn;
    const used =
      config.hubUrlSource === "document" || config.workspacesSource === "document";
    const why =
      rejected === undefined
        ? ""
        : `; ${HUB_CONFIG_PATH} ${used ? "partly used" : "unused"} — ${rejected}`;
    say(
      `uberblick web: hub ${config.hubUrl} (source: ${config.hubUrlSource}), ` +
        `workspaces ${config.workspaces.length} (source: ${config.workspacesSource})${why}`,
    );
    return config;
  });
  return pending;
}

/** Let the next read fetch the document again, so a test can serve another; unused by the app. */
export function rereadClientConfigForTesting(): void {
  pending = null;
}

/** Room acquisition waits for the fetch; the endpoint cannot be a startup constant. */
export function hubUrl(): string {
  return settled().hubUrl;
}

/** Resolved before room acquisition; absent on dev and Caddy serving routes. */
export function defaultPresenceName(): string | null {
  return settled().defaultPresenceName ?? null;
}

/**
 * Runtime-only direct loopback signing secret; a ub open page never has one.
 * Read after configuration settles; empty is the caller's tokenMissing state.
 */
export function hubAuthToken(): string {
  const config = settled();
  return config.servedWorkspaces === undefined ? config.hubAuthToken : "";
}

/** Whether ub open serves this workspace, so its room tokens come from there. */
export function servedLocally(workspace: string): boolean {
  const served = settled().servedWorkspaces;
  if (served === undefined) return false;
  try {
    return Object.hasOwn(served, parseWorkspaceId(workspace).uuid);
  } catch {
    return false;
  }
}

/** The resolved configuration, or the error every reader of it shares. */
function settled(): ClientConfig {
  if (resolved === null) {
    throw new Error(
      "uberblick web: the hub endpoint was read before resolveClientConfig() settled",
    );
  }
  return resolved;
}

/** Display the sanitized endpoint and source only after useHubEndpoint reports ready. */
export function hubEndpoint(): HubEndpoint {
  const config = settled();
  return { url: endpointLabel(config.hubUrl), source: config.hubUrlSource };
}

/** The `ub open` startup binding this page was served with, when there is one. */
export function localServing(workspace?: string): LocalServing | null {
  const config = settled();
  if (config.servedWorkspaces === undefined) return config.localServing;
  const selected = workspace ?? config.workspaces[0];
  if (selected === undefined) return null;
  try {
    return config.servedWorkspaces[parseWorkspaceId(selected).uuid] ?? null;
  } catch {
    return null;
  }
}

/** Local menu labels require no room connection or replica startup. */
export function servedWorkspaceNames(): ReadonlyMap<string, string | null> | null {
  const workspaces = settled().servedWorkspaces;
  return workspaces === undefined ? null : new Map(Object.entries(workspaces).map(([uuid, entry]) => [uuid, entry.name]));
}

/** Empty until config settles: no redirect or menu; useHubEndpoint triggers the update. */
export function configuredWorkspaces(): readonly string[] {
  return resolved?.workspaces ?? [];
}

/** Hub pages stay outside workspace rooms, including after browser sign-in. */
export function browserSignInRequired(): boolean {
  const config = settled();
  // A released Docker proxy can be published on host loopback while its hub
  // still requires a device login. Unlike development or ub open, its public
  // runtime document supplies no signing key or local-serving diagnostic.
  return config.hubUrl !== "" && (
    !isLoopbackEndpoint(config.hubUrl) ||
    (RUNTIME_CONFIG_ONLY && config.hubAuthToken === "" && config.localServing === null && config.servedWorkspaces === undefined)
  );
}
