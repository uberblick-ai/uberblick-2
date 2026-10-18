import type { IncomingMessage, ServerResponse } from "node:http";
import { requestClient } from "./client-address.js";
import type { GithubSignIn } from "./github-sign-in.js";

const ROUTES = ["/auth/browser/start", "/auth/browser/collect", "/auth/browser/cancel",
  "/auth/browser/session", "/auth/browser/sign-out"];

/** Exact origins include ports: localhost services must never share a session. */
function browserOrigin(request: IncomingMessage): string | null {
  const raw = request.headers.origin;
  const site = request.headers["sec-fetch-site"];
  if (typeof raw !== "string" || (site !== undefined && site !== "same-origin")) return null;
  try {
    const origin = new URL(raw);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== raw || origin.host !== request.headers.host) return null;
    return raw;
  } catch { return null; }
}

async function readBody(request: IncomingMessage, path: string): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 4096) throw new Error();
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const body = value as Record<string, unknown>;
  if (path.endsWith("/collect") || path.endsWith("/cancel")) {
    if (Object.keys(body).length !== 2 || typeof body.requestId !== "string" || typeof body.collectionSecret !== "string") throw new Error();
  } else if (path.endsWith("/start")) {
    if (Object.keys(body).some(key => key !== "claimCode") ||
        (body.claimCode !== undefined && typeof body.claimCode !== "string")) throw new Error();
  } else if (Object.keys(body).length !== 0) throw new Error();
  return body;
}

/** Opaque page-held tokens are accepted here only, never by device or room APIs. */
export async function handleBrowserSignIn(
  signIn: GithubSignIn | undefined, request: IncomingMessage, response: ServerResponse,
  behindReleaseProxy = false,
): Promise<boolean> {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/browser/")) return false;
  const reply = (code: number, body: unknown) => {
    response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (!ROUTES.includes(path)) {
    reply(404, { status: "unknown-request" });
    return true;
  }
  if (signIn === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  const origin = browserOrigin(request);
  if (origin === null || request.method !== "POST" || request.headers.authorization !== undefined ||
      request.headers["content-type"]?.split(";")[0] !== "application/json") {
    reply(400, { status: "invalid-request" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = await readBody(request, path);
  } catch {
    reply(400, { status: "invalid-request" });
    return true;
  }
  try {
    if (path.endsWith("/start")) {
      const result = await signIn.startBrowser(origin, requestClient(request, behindReleaseProxy), body.claimCode as string | undefined);
      reply(result.status === "failed" ? 502 : result.status === "busy" ? 429 : result.status === "claim-code-invalid" ? 400 : 200, result);
    } else if (path.endsWith("/collect") || path.endsWith("/cancel")) {
      const requestId = body.requestId as string;
      const secret = body.collectionSecret as string;
      const result = path.endsWith("/cancel") ? signIn.cancelBrowser(requestId, secret, origin)
        : await signIn.collectBrowser(requestId, secret, origin);
      reply(result.status === "unknown-request" ? 404 : 200, result);
    } else {
      const token = request.headers["x-uberblick-session"];
      const session = typeof token === "string" ? signIn.browserSession(token, origin) : null;
      if (session === null) reply(401, { status: "signed-out" });
      else if (path.endsWith("/sign-out")) {
        signIn.signOutBrowser(token as string, origin);
        reply(200, { status: "signed-out" });
      } else reply(200, { status: "signed-in", ...session });
    }
  } catch {
    reply(500, { status: "failed" });
  }
  return true;
}
