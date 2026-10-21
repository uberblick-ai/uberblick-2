/** Request and reply rules shared by the hub's JSON endpoints; imports nothing from team code. */
import type { IncomingMessage, ServerResponse } from "node:http";

export const GITHUB_SIGN_IN_ROUTES = ["/auth/github/start", "/auth/github/collect", "/auth/github/cancel"];
export const BROWSER_SIGN_IN_ROUTES = ["/auth/browser/start", "/auth/browser/collect", "/auth/browser/cancel",
  "/auth/browser/session", "/auth/browser/sign-out"];
/** Every team route besides claim state; a hub without sign-in answers them not-configured. */
export const SIGN_IN_ROUTES = ["/auth/credential/renew", "/auth/manage", ...GITHUB_SIGN_IN_ROUTES, ...BROWSER_SIGN_IN_ROUTES];

/** Replies can carry credentials and access state, so no cache keeps them. */
export function replyJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

/** Secrets travel only in JSON bodies, never in an Authorization header. */
export function isJsonPost(request: IncomingMessage): boolean {
  return request.method === "POST" && request.headers.authorization === undefined &&
    request.headers["content-type"]?.split(";")[0] === "application/json";
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

/** Throws past 4096 bytes, on invalid JSON and on anything but an object. */
export async function readJsonRequest(request: IncomingMessage): Promise<{ text: string; body: Record<string, unknown> }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 4096) throw new Error();
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return { text, body: jsonObject(JSON.parse(text)) };
}

export const GITHUB_HEADERS = { Accept: "application/json", "User-Agent": "Uberblick-Hub", "X-GitHub-Api-Version": "2026-03-10" };

/**
 * Even a successful provider response is bounded before parsing: only a small
 * OAuth result or public identity is needed. Throws past 64 KiB, after an
 * abort, on invalid JSON and on anything but an object.
 */
export async function readGithubJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (response.body === null) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65_536) throw new Error();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  signal.throwIfAborted();
  return jsonObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
