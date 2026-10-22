import { createReadStream, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNC_PROTOCOL_VERSION, isProtocolVersion } from "@uberblick/schema/protocol";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import type { Io } from "./io.js";
import { CONFIG_PATH } from "./open-ports.js";
import { respond } from "./open-response.js";
import { trimmed } from "./strings.js";
import { isInstallPayload } from "./version.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolve the default bundle from this module, independently of the cwd.
const DEFAULT_BUNDLE = join(packageRoot, "..", "web", "dist");

type BundleSource = "default" | "installed" | "override";

export type BundleAction =
  | { action: "serve"; dir: string; source: BundleSource }
  | { action: "missing"; dir: string; source: BundleSource; reason: string };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * An override is the caller's artifact, even when it names the default path.
 */
export function bundlePlan(env: NodeJS.ProcessEnv = process.env): BundleAction {
  const override = trimmed(env.UBERBLICK_WEB_DIST);
  const dir = override === null ? resolve(DEFAULT_BUNDLE) : resolve(override);
  const source = override !== null ? "override" : isInstallPayload() ? "installed" : "default";

  if (isFile(join(dir, "index.html"))) {
    return { action: "serve", dir, source };
  }
  const reason = source === "override"
    ? `UBERBLICK_WEB_DIST names ${dir}, which holds no index.html`
    : source === "installed"
      ? `the installed web app at ${dir} holds no index.html`
      : `there is no built web app at ${dir}`;
  return { action: "missing", dir, source, reason };
}

/**
 * Keep this filename and its syncProtocolVersion field aligned with the
 * stamp emitted by packages/web/vite.config.ts.
 */
const BUILD_STAMP = "uberblick-build.json";

/**
 * Missing, unreadable or malformed stamps all yield null for a normal
 * refusal rather than a stack trace.
 */
function stampedProtocol(dir: string): number | null {
  try {
    const stamp: unknown = JSON.parse(readFileSync(join(dir, BUILD_STAMP), "utf8"));
    const version = (stamp as { syncProtocolVersion?: unknown } | null)?.syncProtocolVersion;
    return isProtocolVersion(version) ? version : null;
  } catch {
    return null;
  }
}

function speaks(stamped: number | null): string {
  return stamped === null
    ? "carries no sync protocol stamp"
    : `speaks sync protocol ${stamped}`;
}

function staleBundle(dir: string, stamped: number | null, source: BundleSource): string {
  if (source === "default") {
    return `error: the web app in ${dir} is missing or out of date\n  → mise run build-web\n`;
  }
  if (source === "installed") {
    return (
      `error: the installed web app at ${dir} ${speaks(stamped)}, and this uberblick speaks ` +
      `${SYNC_PROTOCOL_VERSION} — it could not sync, so it is not being served\n` +
      "  → reinstall Uberblick\n"
    );
  }
  return (
    `error: the web app at ${dir} ${speaks(stamped)}, and this uberblick speaks ` +
    `${SYNC_PROTOCOL_VERSION} — it could not sync, so it is not being served\n` +
    "  → rebuild it with pnpm --filter @uberblick/web build, or mise run build-web from a checkout\n"
  );
}

/**
 * Refuse before hub/database startup without changing the bundle. Compare
 * CLI and bundle protocols here; the hub's protocol is checked at connection.
 * Caller bundles name both versions and a rebuild; installed copies reinstall.
 */
export function ensureBundle(plan: BundleAction, io: Io): "servable" | "refused" {
  if (plan.action === "missing" || !isFile(join(plan.dir, "index.html"))) {
    if (plan.source === "default") {
      io.err(staleBundle(plan.dir, null, plan.source));
      return "refused";
    }
    const reason = plan.action === "missing"
      ? plan.reason
      : `the web app at ${plan.dir} holds no index.html`;
    const recovery = plan.source === "installed"
      ? "reinstall Uberblick"
      : "point UBERBLICK_WEB_DIST at a built bundle, or build one from a checkout — CONTRIBUTING.md's Updating section links the build instructions";
    io.err(`error: ${reason}\n  → ${recovery}\n`);
    return "refused";
  }
  const stamped = stampedProtocol(plan.dir);
  if (stamped === SYNC_PROTOCOL_VERSION) return "servable";
  io.err(staleBundle(plan.dir, stamped, plan.source));
  return "refused";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * SPA deep links fall back to index.html, as in Caddy's try_files rule.
 * Answer CONFIG_PATH first so configuration never receives the HTML fallback.
 * Traversal, absolute paths, malformed escaping and NULs also fall back.
 */
function fileFor(root: string, pathname: string): string {
  const fallback = join(root, "index.html");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return fallback;
  }
  if (decoded.includes("\0")) {
    return fallback;
  }
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return fallback;
  }
  return isFile(candidate) ? candidate : fallback;
}

export function serveBundleRequest(
  root: string,
  document: () => string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    respond(request, response, 405, { allow: "GET, HEAD" }, "");
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname === CONFIG_PATH) {
    respond(
      request,
      response,
      200,
      {
        "content-type": "application/json",
        // Cached configuration would keep a retargeted client on its old hub.
        "cache-control": "no-store",
      },
      document(),
    );
    return;
  }

  const file = fileFor(root, pathname);
  const contentType = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers = {
    "content-type": contentType,
    // The bundle's filenames are content-hashed by Vite, but index.html is
    // not, and a stale one points at assets that are gone.
    "cache-control": "no-cache",
    ...(contentType === MIME[".html"] ? {
      "content-security-policy": WEB_CONTENT_SECURITY_POLICY,
    } : {}),
  };
  if (request.method === "HEAD") {
    respond(request, response, 200, headers, "");
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => {
    respond(request, response, 404, { "content-type": "text/plain" }, "not found\n");
  });
  stream.on("open", () => {
    response.writeHead(200, headers);
    stream.pipe(response);
  });
}
