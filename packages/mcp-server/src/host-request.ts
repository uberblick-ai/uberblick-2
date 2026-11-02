import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readRequestBody } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { isJSONRPCRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

/** Use the SDK's body bound and message schema before reserving a whole batch. */
export async function readHostPost(request: IncomingMessage): Promise<{
  body: unknown;
  calls: number;
} | { status: 400 | 413 }> {
  const webRequest = new Request("http://mcp.invalid/", {
    method: "POST", body: Readable.toWeb(request), duplex: "half",
  } as RequestInit);
  const read = await readRequestBody(webRequest);
  if (read.tooLarge) return { status: 413 };
  try {
    const body: unknown = JSON.parse(read.text);
    const messages = Array.isArray(body) ? body : [body];
    let calls = 0;
    for (const message of messages) {
      const parsed = JSONRPCMessageSchema.safeParse(message);
      if (parsed.success && isJSONRPCRequest(parsed.data)) calls += 1;
    }
    return { body, calls };
  } catch {
    return { status: 400 };
  }
}
