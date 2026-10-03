/** Shared bounded, body-only transport for public authentication requests. */
import type { IncomingMessage, ServerResponse } from "node:http";

export function authReply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function readAuthBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method !== "POST" || request.headers.authorization !== undefined ||
      request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 4096) throw new Error();
    chunks.push(bytes);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
  return body as Record<string, unknown>;
}
