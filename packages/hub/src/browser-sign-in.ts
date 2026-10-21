import type { IncomingMessage, ServerResponse } from "node:http";
import { requestClient } from "./client-address.js";
import type { GithubSignIn } from "./github-sign-in.js";
import { BROWSER_SIGN_IN_ROUTES, isJsonPost, readJsonRequest, replyJson } from "./http.js";

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

/** Opaque page-held tokens are accepted here only, never by device or room APIs. */
export async function handleBrowserSignIn(
  signIn: GithubSignIn | undefined, request: IncomingMessage, response: ServerResponse,
  behindReleaseProxy = false,
): Promise<boolean> {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/browser/")) return false;
  const reply = (code: number, body: unknown) => replyJson(response, code, body);
  if (!BROWSER_SIGN_IN_ROUTES.includes(path)) {
    reply(404, { status: "unknown-request" });
    return true;
  }
  if (signIn === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  const origin = browserOrigin(request);
  if (origin === null || !isJsonPost(request)) {
    reply(400, { status: "invalid-request" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = (await readJsonRequest(request)).body;
    if (path.endsWith("/collect") || path.endsWith("/cancel")) {
      if (Object.keys(body).length !== 2 || typeof body.requestId !== "string" || typeof body.collectionSecret !== "string") throw new Error();
    } else if (Object.keys(body).length !== 0) throw new Error();
  } catch {
    reply(400, { status: "invalid-request" });
    return true;
  }
  try {
    if (path.endsWith("/start")) {
      const result = await signIn.startBrowser(origin, requestClient(request, behindReleaseProxy));
      reply(result.status === "failed" ? 502 : result.status === "busy" ? 429 : 200, result);
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
