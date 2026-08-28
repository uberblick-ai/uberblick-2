/**
 * Client configuration.
 *
 * The hub endpoint, the workspaces this client offers *and* the signing secret
 * it mints tokens with are resolved at *runtime*, from a JSON document the same
 * origin serves at {@link HUB_CONFIG_PATH}. A bundle reaches users who cannot
 * rebuild it — `ub` serves the web UI — so a value baked at our build time
 * would pin every one of those bundles to one hub, one workspace and one
 * secret. Everything else here is still injected by Vite `define` (see
 * vite.config.ts).
 *
 * The path and the shape are contract, not implementation detail: this module,
 * the Caddy config, the dev server's own plugin (`dev-config-document.ts`) and
 * `ub open` (#97) all have to agree on them. The document is
 *
 *     {"hubUrl": "wss://host/ws", "workspaces": ["uberblick-<uuid>", "<uuid>"],
 *      "hubAuthToken": "<the hub's signing secret>"}
 *
 * — three keys, anything else ignored. `hubUrl` must be a bare `ws://` or
 * `wss://` address: no userinfo, no query, no fragment. `workspaces` is the
 * menu, in order, and its first entry is what `/` — the one address that names
 * no workspace — redirects to. It may also be written as one comma-separated
 * string, because the environments that serve this document substitute plain
 * strings and cannot build a JSON array (see the Caddyfile).
 * A document that plainly names any of the keys more than once is refused,
 * because `JSON.parse` would otherwise keep the *last* occurrence — what a
 * value injected through such a substitution produces. That check is
 * best-effort defence in depth; what guarantees it cannot happen is the deploy
 * wrapper refusing a value that could close a JSON string in the first place.
 *
 * **This document is the credential channel, by design (#426, #410).** An
 * earlier version of this comment said the opposite — that carrying the
 * endpoint and nothing else was what kept it from becoming one. That is
 * deliberately overturned: the secret used to be compiled into the bundle,
 * which pinned every image and every `ub open` build to one hub's secret and is
 * the single reason the image cannot be published. Serving it instead changes
 * *where* the same secret is published, not *whether*: anyone who can fetch
 * this document has full read-write on the workspaces it names. The boundary
 * that makes that acceptable is the tailnet (REMOTE.md, CLAUDE.md) — the
 * owner's own devices and nothing else — and it includes `mise run web`, which
 * serves the owner's own secret to anything that can reach the dev server.
 * Real per-session credentials are the replacement, deferred with #388.
 *
 * Rule from CLAUDE.md: no hardcoded hub addresses anywhere except the in-code
 * fallback default. There are still exactly two, both fallbacks behind the
 * served document: the one vite.config.ts substitutes when HUB_URL is unset in
 * the build environment, and FALLBACK_HUB_URL below, which applies when this
 * module is loaded outside a Vite build and nothing was injected.
 * {@link resolveClientConfig} reports which of the three it used. The secret
 * has no such fallback: a document that does not carry one leaves this client
 * unable to authenticate, and {@link resolveClientConfig} does not memoise that
 * answer.
 */

import { parseWorkspaceId } from "@uberblick/schema";

// Injected as string literals at build time. Declared, never imported.
declare const __HUB_URL__: string;
declare const __WORKSPACE_ID__: string;
declare const __WORKSPACES__: string;

/** Fallback used only when this module is loaded outside a Vite build. */
const FALLBACK_HUB_URL = "ws://localhost:1234";

/**
 * Where the client looks for its runtime configuration, on its own origin.
 *
 * Any static server can satisfy this: it is one file of JSON. Serve it with
 * `Cache-Control: no-store` — a cached copy keeps an already retargeted
 * deployment dialling the old hub, which is the failure this mechanism exists
 * to remove.
 */
export const HUB_CONFIG_PATH = "/uberblick-config.json";

/** Which of the three sources supplied a value actually in use. */
export type ConfigSource = "document" | "define" | "fallback";

export interface ClientConfig {
  /** The hub this session dials. */
  hubUrl: string;
  hubUrlSource: ConfigSource;
  /**
   * The workspaces on the switcher's menu, in order — the first is what `/`
   * redirects to. Empty when nothing configured any.
   *
   * Entries are kept exactly as configured, decoration and all: the slug is
   * display, and `ui/route.ts` owns what a workspace id is. A define-supplied
   * entry is deliberately *not* validated here — a build carrying the legacy
   * `main` has to reach `parseRoute`, which is what tells its developer the
   * configured value is not a workspace id rather than that there is none
   * (#182). A document-supplied one is validated, because a typo in a deployed
   * config file is not somewhere anyone can go.
   */
  workspaces: readonly string[];
  /** No `"fallback"`: there is no in-code workspace, only a build without one. */
  workspacesSource: "document" | "define";
  /**
   * The hub's signing secret, as the served document supplied it — empty when
   * it supplied none.
   *
   * No source field and no built-in alternative: this is the one value with
   * nothing to fall back *to*, so "where did it come from" has one answer and
   * "is there one at all" is the whole question. Empty is a state the UI names
   * rather than a state it hides — see `RoomStatus.tokenMissing`.
   */
  hubAuthToken: string;
}

/**
 * The hub this session dialled, as a reader may be *shown* it (#362).
 *
 * Two facts, because "synced" without "with what" is not a status: one machine
 * legitimately runs several hubs — a dev island and a promoted remote — and two
 * tabs of the same workspace can each be perfectly synced to a different world.
 * The source travels with the address because falling back to compiled values
 * is exactly how a tab lands on the wrong one.
 */
export interface HubEndpoint {
  /** The address, or null when the configured value is not one — see {@link endpointLabel}. */
  url: string | null;
  source: ConfigSource;
}

/**
 * The endpoint of `value`, and nothing else: scheme, host, path.
 *
 * Rebuilt from the parsed parts rather than trimmed, so no userinfo, query or
 * fragment can survive into anything that renders it. `usableEndpoint` already
 * refuses all three in the *served* document, but the build-time defines are
 * not validated at all — a `HUB_URL` of `ws://user:pass@host` would otherwise
 * reach the screen the moment a surface started naming the endpoint.
 *
 * Null rather than a best effort when the value does not parse *or* is not an
 * address this client could dial: a string this cannot take apart is one it
 * cannot promise anything about, and the socket built from it has failed
 * anyway. The scheme check is the same one `usableEndpoint` makes, and it is
 * load-bearing here rather than cosmetic — `new URL` leaves an opaque scheme's
 * payload in `pathname` with an empty host, so a `mailto:agent:s3cret@host`
 * would otherwise be re-emitted verbatim. A lone `/` path is dropped because
 * that is what `new URL` adds to a bare host, and the two spellings are one
 * address.
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

/**
 * How an endpoint's source reads to someone asking which hub they are on.
 *
 * One wording in one place: the sync panel states it and the header pill
 * carries it on hover, and two different phrasings for one fact would be worse
 * than either. Every non-document answer names {@link HUB_CONFIG_PATH} rather
 * than merely omitting it — "the served document did not decide this" is the
 * half that diagnoses a tab on the wrong hub.
 */
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

/**
 * What to use when the document cannot supply an endpoint.
 *
 * Keyed off whether a `define` was injected at all rather than off the value,
 * so the reported source stays truthful when a build's `HUB_URL` happens to
 * equal the in-code fallback — which is the common case, not a corner one.
 */
const BUILT_IN_HUB_URL: Pick<ClientConfig, "hubUrl" | "hubUrlSource"> =
  typeof __HUB_URL__ === "string" && __HUB_URL__ !== ""
    ? { hubUrl: __HUB_URL__, hubUrlSource: "define" }
    : { hubUrl: FALLBACK_HUB_URL, hubUrlSource: "fallback" };

/**
 * The workspaces a build carries: `WORKSPACE_ID` first — it is the one that has
 * always answered `/` — then `WORKSPACES`, the menu.
 *
 * One ordered list, because the served document is one ordered list and the
 * client must not hold two different ideas of what a workspace list is. Both
 * defines are fallbacks behind that document, on every path: the dev server
 * serves one too (#426), so they are the answer only where none arrives at all.
 *
 * Repeats are dropped, because naming the default workspace in `WORKSPACES` as
 * well is the ordinary configuration and the count in the diagnostic has to
 * match the menu. Two *spellings* of one workspace are a uuid comparison, which
 * `workspaceList` owns.
 */
const BUILT_IN_WORKSPACES: readonly string[] = [
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
  // Nothing to fall back to: no build injects a secret any more (#426), so a
  // client whose document did not arrive has none.
  hubAuthToken: "",
};

/**
 * Whether `value` is an address this client may dial, and nothing more.
 *
 * A non-empty string is not enough. An `https://` or malformed value would be
 * reported as `source: "document"` and then throw inside socket construction
 * rather than falling back, and userinfo or a query string is how a credential
 * gets into a URL — which this document must never carry, and which would then
 * be transmitted and printed in every diagnostic that named the endpoint.
 */
function usableEndpoint(value: string): { url: string } | { rejected: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { rejected: "hubUrl is not an absolute URL" };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { rejected: "hubUrl is not a ws:// or wss:// URL" };
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return { rejected: "hubUrl carries credentials (userinfo, query or fragment)" };
  }
  // The parsed form, not the raw string: `new URL` accepts surrounding
  // whitespace that the websocket constructor would then choke on.
  return { url: parsed.href };
}

/**
 * The workspaces the document lists, or why it supplied none.
 *
 * Two spellings, one meaning: a JSON array of ids, or one comma-separated
 * string. The string form exists because the deployment that serves this
 * document is a Caddy `respond` with an environment variable substituted into
 * it, and an operator's `.env` holds `a,b` — the same spelling `WORKSPACES`
 * already has in mise `[env]`. Refusing it would have put JSON quoting rules
 * into a dotenv file.
 *
 * An entry that is not a workspace id is dropped and counted, never offered: a
 * menu item that navigates to the invalid-link screen reads as a broken
 * workspace. `dropped` is a count and nothing more — it reaches one diagnostic,
 * and this document is the one place a value must never be echoed.
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
    // An empty entry is a formatting artefact of the string spelling (`a,,b`,
    // or an unset variable substituting to nothing), not a typo anybody needs
    // to be told about. Every other unusable entry is counted, whatever its
    // type: a list whose entries are half numbers has to say so.
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
  hubUrl: { url: string } | { rejected: string };
  workspaces: { list: string[]; dropped: number } | { rejected: string };
  /** Empty when the document named no usable secret. */
  hubAuthToken: string;
}

/**
 * What the document says, or the reason none of it could be used.
 *
 * A document-level failure is deliberately *one* outcome covering a non-200, a
 * non-JSON body and JSON that is not an object. Under the SPA fallback (#68),
 * `try_files … /index.html` answers an absent document with 200 and the app's
 * own HTML, so "missing" and "wrong shape" are the same observation in
 * production — splitting them would mean a branch only the dev server ever
 * takes.
 *
 * Its two keys then fail *independently*: a deployment that serves an endpoint
 * but no workspaces is an ordinary deployment — a hub is required, a workspace
 * list is not — and it must keep its endpoint. Extra keys are ignored rather
 * than rejected: a document that grows another key must not strand an already
 * deployed bundle.
 *
 * No reason ever quotes the response. A misrouted request can return anything —
 * an upstream error page, another service's secret — and a diagnostic that
 * echoed it would copy that into the browser console and every log that
 * collects one. The rejected values are withheld for the same reason: the ones
 * most worth naming are exactly the ones that might carry a credential.
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
    // Overwhelmingly the SPA fallback handing back index.html, which the
    // content type says without quoting a byte of it.
    const said = contentType === "" ? "no content type" : contentType;
    return { rejected: `it is not JSON (content type: ${said})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rejected: "it is not a JSON object" };
  }
  // Best-effort, and deliberately not more than that.
  //
  // The deployed document is a template with values substituted into it (see
  // the Caddyfile), so a value carrying a quote could close its string and
  // append `,"hubUrl":"wss://elsewhere"` — which `JSON.parse` would then keep,
  // last occurrence winning. The *guarantee* against that is `remote-compose.sh`
  // refusing any `WEB_WORKSPACES` or `HUB_AUTH_TOKEN` outside a safe alphabet:
  // no quote and no backslash ever reaches the body, so no escape can be
  // written into it.
  //
  // This check is defence in depth for the plainly spelled case, and it reads
  // raw JSON *spelling*: an escaped key (`"hub\u0055rl"`) decodes to a second
  // `hubUrl` and passes it. That is not a hole worth a tokenizer — anyone who
  // can write escapes into the served document can set `hubUrl` outright, and a
  // document an attacker controls is outside this model.
  //
  // Two anchors keep it from firing on a *value* rather than on a key, which
  // since #426 would mean refusing a whole document — the credential in it
  // included — over the text of an opaque secret. `\s*:` so a value that merely
  // contains `"hubUrl"` is not taken for a key, and a leading `[^\\]` so one
  // spelling out `,"hubUrl":` is not either: the body parsed as JSON above, so
  // a quote inside a string is written `\"`, while a real key's opening quote
  // can only follow `{` or `,`.
  const twice = ["hubUrl", "workspaces", "hubAuthToken"].find(
    (key) => (body.match(new RegExp(`(^|[^\\\\])"${key}"\\s*:`, "g")) ?? []).length > 1,
  );
  if (twice !== undefined) {
    return { rejected: `it names ${twice} more than once` };
  }
  const document = parsed as Record<string, unknown>;
  const url = document.hubUrl;
  const secret = document.hubAuthToken;
  return {
    hubUrl:
      typeof url === "string" && url !== ""
        ? usableEndpoint(url)
        : { rejected: "it has no string hubUrl" },
    workspaces: usableWorkspaces(document.workspaces),
    // A non-string is refused rather than coerced, and without a reason: an
    // unusable secret leaves the client in exactly the state an absent one
    // does, and this is the one value whose shape must never reach a
    // diagnostic. What a reader is told is the state, not the document — see
    // `RoomStatus.tokenMissing`.
    hubAuthToken: typeof secret === "string" ? secret.trim() : "",
  };
}

/**
 * How long the read may take before the built-in values are used instead.
 *
 * Not a nicety. Room acquisition waits on this read, and a request that hangs
 * — a proxy holding the connection open, a captive portal — never rejects on
 * its own, so without a deadline the app would sit with no rooms at all, not
 * even the IndexedDB-backed ones it could serve offline. A few seconds is long
 * enough for a same-origin file and short enough to be a blink.
 */
export const HUB_CONFIG_TIMEOUT_MS = 3_000;

/**
 * Read the client configuration: the served document, else the build-time
 * defines, else the in-code fallback.
 *
 * Never rejects, and always settles. A client left with no hub at all would be
 * worse than one dialling a stale address, and the `rejected` reason — which
 * {@link resolveClientConfig} logs — is what keeps the difference legible.
 */
export async function readClientConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = HUB_CONFIG_TIMEOUT_MS,
): Promise<ClientConfig & { rejected?: string }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let status: number;
  let contentType: string;
  let body: string;
  try {
    const response = await fetchImpl(HUB_CONFIG_PATH, {
      // Belt to the server's braces: the endpoint a tab dials must be the one
      // deployed now, never one a cache kept from a previous deployment.
      cache: "no-store",
      // Keeps a history-API fallback that honours `Accept` (Vite's dev server
      // does) answering 404 rather than HTML. Caddy's `try_files` does not, so
      // `readDocument` still has to survive HTML.
      headers: { Accept: "application/json" },
      // Covers reading the body too, not just the headers: aborting the signal
      // rejects an in-flight `text()`, which is the other place this can hang.
      signal: deadline.signal,
    });
    status = response.status;
    contentType = response.headers.get("content-type") ?? "";
    body = await response.text();
  } catch (error) {
    if (deadline.signal.aborted) {
      return { ...BUILT_IN, rejected: `it did not answer within ${timeoutMs}ms` };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { ...BUILT_IN, rejected: `it could not be fetched (${reason})` };
  } finally {
    clearTimeout(timer);
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

  return {
    ...("rejected" in outcome.hubUrl
      ? BUILT_IN_HUB_URL
      : { hubUrl: outcome.hubUrl.url, hubUrlSource: "document" as const }),
    ...("rejected" in outcome.workspaces
      ? { workspaces: BUILT_IN_WORKSPACES, workspacesSource: "define" as const }
      : { workspaces: outcome.workspaces.list, workspacesSource: "document" as const }),
    hubAuthToken: outcome.hubAuthToken,
    ...(notes.length === 0 ? {} : { rejected: notes.join("; ") }),
  };
}

let resolved: ClientConfig | null = null;
let pending: Promise<ClientConfig> | null = null;

/**
 * Resolve the configuration, once per session, and say where it came from.
 *
 * Memoised rather than merely idempotent: the entry module starts the read as
 * early as it can, and the hook that gates room acquisition on it joins that
 * same read instead of issuing a second one.
 *
 * **Except when no secret arrived.** With the secret served rather than
 * compiled in (#426), a document that missed its deadline — a proxy holding the
 * request open, a host still starting — used to leave a tab that could never
 * authenticate for as long as it stayed open, because the miss was remembered.
 * So that one answer is not kept: the endpoint and the workspaces settle as
 * they always did, and the next caller re-reads the document under the same
 * deadline. `rooms.ts` calls this before every connect attempt, which is what
 * turns "not memoised" into "tries again".
 */
export function resolveClientConfig(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ClientConfig> {
  pending ??= readClientConfig(fetchImpl).then(({ rejected, ...config }) => {
    resolved = config;
    if (config.hubAuthToken === "") pending = null;
    // One line, always: the sources in force, and — when there was one — why
    // the document was not used. A hub that is merely misconfigured otherwise
    // looks exactly like a hub that is down, and a switcher with nothing on it
    // looks exactly like a deployment that was never given a workspace.
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

/**
 * The resolved hub endpoint, for the one caller that dials it.
 *
 * A function, not a `const`: the value is not known until a `fetch` completes,
 * and `rooms.ts` builds the shared websocket from a React effect, which
 * `useHubEndpoint` holds back until {@link resolveClientConfig} has settled.
 */
export function hubUrl(): string {
  return settled().hubUrl;
}

/**
 * The signing secret in force, for the one caller that mints tokens with it.
 *
 * Gated exactly like {@link hubUrl}, and for the same reason: it is not known
 * until a `fetch` completes. Empty means the served document carried none —
 * which is a state, not an error, and the caller is what says so.
 */
export function hubAuthToken(): string {
  return settled().hubAuthToken;
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

/**
 * The endpoint as the UI may say it, with where it came from (#362).
 *
 * Deliberately not `hubUrl()`: that one is dialled, this one is displayed, and
 * the displayed form is stripped to the address alone. Gated the same way — the
 * surfaces that call it render "—" until `useHubEndpoint` reports ready.
 */
export function hubEndpoint(): HubEndpoint {
  const config = settled();
  return { url: endpointLabel(config.hubUrl), source: config.hubUrlSource };
}

/**
 * The workspaces in force — the switcher's menu, first entry answering `/`.
 *
 * Empty before the read settles, which is the same answer as "none configured"
 * and wants the same behaviour: no redirect out of `/`, no menu. The read gates
 * the first *connect*, not the render, so `App` does render before it settles;
 * `useHubEndpoint` is what re-renders it with the answer.
 */
export function configuredWorkspaces(): readonly string[] {
  return resolved?.workspaces ?? [];
}
