/**
 * Client configuration.
 *
 * The hub endpoint is resolved at *runtime*, from a JSON document the same
 * origin serves at {@link HUB_CONFIG_PATH}. A bundle reaches users who cannot
 * rebuild it — `ub` serves the web UI — so a value baked at our build time
 * would pin every one of those bundles to one hub. Everything else here is
 * still injected by Vite `define` (see vite.config.ts).
 *
 * The path and the shape are contract, not implementation detail: this module,
 * the Caddy config and `ub open` (#97) all have to agree on them. The document
 * is `{"hubUrl": "wss://host/ws"}` — one key, a string, anything else ignored.
 * The value must be a bare `ws://` or `wss://` address: no userinfo, no query,
 * no fragment. It carries the endpoint and nothing else, which is what keeps it
 * from becoming a credential channel; #84 owns the signing secret that is still
 * compiled into the bundle.
 *
 * Rule from CLAUDE.md: no hardcoded hub addresses anywhere except the in-code
 * fallback default. There are still exactly two, both fallbacks behind the
 * served document: the one vite.config.ts substitutes when HUB_URL is unset in
 * the build environment, and FALLBACK_HUB_URL below, which applies when this
 * module is loaded outside a Vite build and nothing was injected.
 * {@link resolveHubUrl} reports which of the three it used.
 *
 * ============================ LOUD WARNING ============================
 * HUB_AUTH_TOKEN is compiled into the bundle. That is PRIVATE-SPIKE-ONLY — a
 * browser bundle is public, so this is not a secret once served. REMOTE.md
 * limits the remote deployment to a private Tailscale network. The hosted
 * design mints a per-OAuth-session token server-side and the signing secret
 * never reaches the client.
 * =====================================================================
 */

// Injected as string literals at build time. Declared, never imported.
declare const __HUB_URL__: string;
declare const __HUB_AUTH_TOKEN__: string;
declare const __WORKSPACE_ID__: string;

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

function injected(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

/** Which of the three sources supplied the endpoint actually in use. */
export type HubUrlSource = "document" | "define" | "fallback";

export interface HubUrlResolution {
  url: string;
  source: HubUrlSource;
}

/**
 * What to use when the document cannot supply an endpoint.
 *
 * Keyed off whether a `define` was injected at all rather than off the value,
 * so the reported source stays truthful when a build's `HUB_URL` happens to
 * equal the in-code fallback — which is the common case, not a corner one.
 */
const BUILT_IN: HubUrlResolution =
  typeof __HUB_URL__ === "string" && __HUB_URL__ !== ""
    ? { url: __HUB_URL__, source: "define" }
    : { url: FALLBACK_HUB_URL, source: "fallback" };

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
 * The endpoint the document names, or the reason it could not be used.
 *
 * Unusable is deliberately *one* outcome covering a non-200, a non-JSON body,
 * JSON without a string `hubUrl`, and a `hubUrl` that is not a bare ws(s)
 * address. Under the SPA fallback (#68), `try_files … /index.html` answers an
 * absent document with 200 and the app's own HTML, so "missing" and "wrong
 * shape" are the same observation in production — splitting them would mean a
 * branch only the dev server ever takes. Extra keys are ignored rather than
 * rejected: the contract is one key, and a document that grows another must not
 * strand an already deployed bundle.
 *
 * No reason ever quotes the response. A misrouted request can return anything —
 * an upstream error page, another service's secret — and a diagnostic that
 * echoed it would copy that into the browser console and every log that
 * collects one. The rejected `hubUrl` is withheld for the same reason: the
 * values most worth naming are exactly the ones that might carry a credential.
 */
function readDocument(
  status: number,
  contentType: string,
  body: string,
): { url: string } | { rejected: string } {
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
  const url = (parsed as Record<string, unknown>).hubUrl;
  if (typeof url !== "string" || url === "") {
    return { rejected: "it has no string hubUrl" };
  }
  return usableEndpoint(url);
}

/**
 * How long the read may take before the built-in value is used instead.
 *
 * Not a nicety. Room acquisition waits on this read, and a request that hangs
 * — a proxy holding the connection open, a captive portal — never rejects on
 * its own, so without a deadline the app would sit with no rooms at all, not
 * even the IndexedDB-backed ones it could serve offline. A few seconds is long
 * enough for a same-origin file and short enough to be a blink.
 */
export const HUB_CONFIG_TIMEOUT_MS = 3_000;

/**
 * Read the hub endpoint: the served document, else the build-time define, else
 * the in-code fallback.
 *
 * Never rejects, and always settles. A client left with no hub at all would be
 * worse than one dialling a stale address, and the `rejected` reason — which
 * {@link resolveHubUrl} logs — is what keeps the difference legible.
 */
export async function readHubUrl(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = HUB_CONFIG_TIMEOUT_MS,
): Promise<HubUrlResolution & { rejected?: string }> {
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
  return { url: outcome.url, source: "document" };
}

let resolved: HubUrlResolution | null = null;
let pending: Promise<HubUrlResolution> | null = null;

/**
 * Resolve the endpoint, once per session, and say where it came from.
 *
 * Memoised rather than merely idempotent: the entry module starts the read as
 * early as it can, and the hook that gates room acquisition on it joins that
 * same read instead of issuing a second one.
 */
export function resolveHubUrl(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<HubUrlResolution> {
  pending ??= readHubUrl(fetchImpl).then(({ url, source, rejected }) => {
    resolved = { url, source };
    // One line, always: the source in force, and — when there was one — why the
    // document was not used. A hub that is merely misconfigured otherwise looks
    // exactly like a hub that is down.
    const say = rejected === undefined ? console.info : console.warn;
    const why =
      rejected === undefined ? "" : `; ${HUB_CONFIG_PATH} unused — ${rejected}`;
    say(`uberblick web: hub ${url} (source: ${source})${why}`);
    return resolved;
  });
  return pending;
}

/**
 * The resolved hub endpoint, for the one caller that dials it.
 *
 * A function, not a `const`: the value is not known until a `fetch` completes,
 * and `rooms.ts` builds the shared websocket from a React effect, which
 * `useHubEndpoint` holds back until {@link resolveHubUrl} has settled.
 */
export function hubUrl(): string {
  if (resolved === null) {
    throw new Error(
      "uberblick web: the hub endpoint was read before resolveHubUrl() settled",
    );
  }
  return resolved.url;
}

/**
 * The hub's dev signing secret. Empty when `fnox exec` could not decrypt it
 * (`--if-missing warn`), which is a legitimate state: contributors without the
 * age key still get a running dev server, they just cannot authenticate.
 */
export const HUB_AUTH_TOKEN: string = injected(
  typeof __HUB_AUTH_TOKEN__ === "string" ? __HUB_AUTH_TOKEN__ : undefined,
  "",
);

/**
 * The workspace this build was configured with, or null when it was built
 * without one.
 *
 * It answers exactly one address — `/`, which names no workspace — by
 * redirecting to it. Every other address carries its own workspace in the first
 * path segment, because this client cannot enumerate workspaces and must never
 * guess which corpus a link belongs to.
 *
 * Injected from `WORKSPACE_ID` at build time, the way `__HUB_URL__` is: mise
 * `[env]` supplies it in dev (`ub init` writes it into the derived
 * `mise.local.toml`), and a bundle built without one simply has no `/`.
 */
export const CONFIGURED_WORKSPACE: string | null =
  typeof __WORKSPACE_ID__ === "string" && __WORKSPACE_ID__ !== ""
    ? __WORKSPACE_ID__
    : null;

/**
 * The repository whose issue and PR links render as a bare `#62` — every other
 * repository reads `org/repo#62`. Display only; see editor/github-refs.ts.
 *
 * A plain constant, flagged as such: the spike has one repository and one
 * workspace, and the honest place for this once a hosted hub has many is a
 * per-workspace setting, not a build-time value. Compared case-insensitively,
 * because GitHub's own slugs are.
 */
export const GITHUB_REPO = "uberblick-ai/uberblick-2";
